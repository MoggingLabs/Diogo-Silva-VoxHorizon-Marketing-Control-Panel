"""Async HTTP client for the worker's ``/work/queue/*`` REST surface.

Every method maps one-to-one to a route in
``worker/src/routes/work_queue.py`` (PR-1). Bearer-authed via
``WORKER_SHARED_SECRET``. The client is intentionally thin: it owns wire
shape and error classification, nothing else. The drain loop owns
sequencing and the heartbeat task.

Error classification
--------------------
The worker returns these statuses for the queue surface:

* ``2xx`` — success. ``204`` from the no-row-due claim path is mapped to
  ``None`` so the caller does not have to inspect status codes.
* ``401 / 403`` — bad bearer. Raised as :class:`QueueAuthError`; the
  daemon escalates this to a fatal because no retry will fix a misconfigured
  secret.
* ``409`` — ``claim_token rotated``. Raised as :class:`QueueConflictError`;
  the heartbeat / complete / fail / cancel callers handle it by aborting
  the in-flight work cleanly and looping back to claim.
* ``5xx`` and any transport error — :class:`QueueServerError`. tenacity
  retries with exponential backoff (capped) before bubbling up.
"""

from __future__ import annotations

from typing import Any, Mapping

import httpx
import structlog
from tenacity import (
    AsyncRetrying,
    retry_if_exception_type,
    stop_after_attempt,
    wait_exponential,
)

from .types import ConsumerStatus, WorkItem, WorkItemKind


log = structlog.get_logger(__name__)


# ---------------------------------------------------------------------------
# Exceptions
# ---------------------------------------------------------------------------


class QueueClientError(RuntimeError):
    """Base for every queue-client failure mode."""


class QueueAuthError(QueueClientError):
    """The worker rejected the bearer token (401/403). Fatal at the daemon."""


class QueueConflictError(QueueClientError):
    """The claim_token was rotated by the watchdog (409). Caller aborts cleanly."""


class QueueServerError(QueueClientError):
    """A 5xx or transport-level error. Retryable."""


# ---------------------------------------------------------------------------
# Client
# ---------------------------------------------------------------------------


class QueueClient:
    """Async wrapper over the worker's work_queue surface.

    Lifecycle:

    .. code-block:: python

        async with QueueClient(base_url=..., secret=...) as client:
            work_item = await client.claim("operator_dispatch")
            ...
    """

    def __init__(
        self,
        *,
        base_url: str,
        secret: str,
        timeout_s: float = 30.0,
        # Tests inject a transport (respx.mock) to short-circuit the network.
        client: httpx.AsyncClient | None = None,
        # Retry attempts on QueueServerError. Default 4 (initial + 3 retries).
        retry_attempts: int = 4,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._secret = secret
        self._timeout_s = timeout_s
        self._client = client
        self._owns_client = client is None
        self._retry_attempts = retry_attempts

    async def __aenter__(self) -> "QueueClient":
        if self._client is None:
            self._client = httpx.AsyncClient(
                base_url=self._base_url,
                timeout=self._timeout_s,
                headers={"Authorization": f"Bearer {self._secret}"},
            )
        return self

    async def __aexit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
        if self._owns_client and self._client is not None:
            await self._client.aclose()
            self._client = None

    # ------------------------------------------------------------------
    # internals
    # ------------------------------------------------------------------

    def _require_client(self) -> httpx.AsyncClient:
        if self._client is None:
            raise RuntimeError(
                "QueueClient used outside its async context manager"
            )
        return self._client

    async def _request(
        self,
        method: str,
        path: str,
        *,
        json: Mapping[str, Any] | None = None,
        retryable: bool = True,
    ) -> httpx.Response:
        """One HTTP round-trip with classification + optional retry.

        Auth (401/403) is FATAL on the daemon's side and is never retried.
        Conflict (409) is BUSINESS-LEVEL and never retried; the caller acts
        on it. 5xx and transport errors are retried with backoff.
        """
        client = self._require_client()
        url = path if path.startswith("/") else f"/{path}"

        async def _attempt() -> httpx.Response:
            try:
                resp = await client.request(
                    method, url, json=dict(json) if json is not None else None
                )
            except httpx.RequestError as exc:
                # Connection refused, DNS failure, read timeout, etc. Treat
                # as 5xx-equivalent so tenacity retries.
                raise QueueServerError(f"transport error: {exc}") from exc
            if resp.status_code in (401, 403):
                raise QueueAuthError(
                    f"worker rejected bearer ({resp.status_code}): "
                    f"{resp.text[:200]}"
                )
            if resp.status_code == 409:
                raise QueueConflictError(
                    f"claim_token rotated: {resp.text[:200]}"
                )
            if resp.status_code >= 500:
                raise QueueServerError(
                    f"worker {resp.status_code}: {resp.text[:200]}"
                )
            return resp

        if not retryable:
            return await _attempt()

        async for attempt in AsyncRetrying(
            stop=stop_after_attempt(self._retry_attempts),
            wait=wait_exponential(multiplier=0.5, min=0.5, max=10),
            retry=retry_if_exception_type(QueueServerError),
            reraise=True,
        ):
            with attempt:
                return await _attempt()
        # AsyncRetrying with reraise=True ensures we either return inside the
        # loop or raise; this line keeps the type checker happy.
        raise QueueServerError(  # pragma: no cover - unreachable safety net
            "unreachable: retry loop did not return"
        )

    # ------------------------------------------------------------------
    # public API
    # ------------------------------------------------------------------

    async def health_ping(self) -> bool:
        """GET /work/health — returns True iff the worker responds 2xx.

        Used by :mod:`startup` as the reachability probe. Auth failures
        propagate (a bad secret IS a startup failure).
        """
        resp = await self._request("GET", "/work/health", retryable=False)
        return 200 <= resp.status_code < 300

    async def claim(self, kind: WorkItemKind) -> WorkItem | None:
        """POST /work/queue/claim — claim the next due row of ``kind``.

        Returns ``None`` when the worker reports no row due (204) so the
        drain loop can sleep instead of inspecting status codes.
        """
        resp = await self._request(
            "POST",
            "/work/queue/claim",
            json={"kind": kind, "consumer_id": self._consumer_id_for_claim()},
        )
        if resp.status_code == 204:
            return None
        if 200 <= resp.status_code < 300:
            return WorkItem.model_validate(resp.json())
        # Anything else has already been raised inside _request; if we got
        # here the worker returned a 4xx we did not classify.
        raise QueueClientError(f"unexpected status {resp.status_code}: {resp.text[:200]}")

    # The daemon's settings supply the consumer id; the client stores it so
    # callers do not have to thread it through every call. Setter rather than
    # constructor arg so the QueueClient stays general (the startup module also
    # constructs one before settings are fully loaded in tests).
    _consumer_id: str = "operator-daemon-unset"

    def set_consumer_id(self, consumer_id: str) -> None:
        self._consumer_id = consumer_id

    def _consumer_id_for_claim(self) -> str:
        return self._consumer_id

    async def heartbeat_work_item(
        self, work_item_id: str, claim_token: str
    ) -> bool:
        """PATCH /work/queue/{id}/heartbeat. Returns False on token rotation."""
        try:
            await self._request(
                "PATCH",
                f"/work/queue/{work_item_id}/heartbeat",
                json={"claim_token": claim_token},
            )
        except QueueConflictError:
            return False
        return True

    async def complete(
        self,
        work_item_id: str,
        claim_token: str,
        result: dict[str, Any] | None = None,
    ) -> bool:
        """PATCH /work/queue/{id}/complete. Returns False on token rotation."""
        try:
            await self._request(
                "PATCH",
                f"/work/queue/{work_item_id}/complete",
                json={"claim_token": claim_token, "result": result},
            )
        except QueueConflictError:
            return False
        return True

    async def fail(
        self,
        work_item_id: str,
        claim_token: str,
        error_kind: str,
        error_detail: dict[str, Any] | None = None,
        retryable: bool = True,
        backoff_seconds: int = 60,
    ) -> bool:
        """PATCH /work/queue/{id}/fail. Returns False on token rotation."""
        body: dict[str, Any] = {
            "claim_token": claim_token,
            "error_kind": error_kind,
            "error_detail": error_detail,
            "retryable": retryable,
            "backoff_seconds": backoff_seconds,
        }
        try:
            await self._request(
                "PATCH", f"/work/queue/{work_item_id}/fail", json=body
            )
        except QueueConflictError:
            return False
        return True

    async def cancel(
        self,
        work_item_id: str,
        claim_token: str | None,
        reason: str = "user_cancelled",
    ) -> bool:
        """PATCH /work/queue/{id}/cancel. Token-scoped when token is provided."""
        body: dict[str, Any] = {"reason": reason}
        if claim_token is not None:
            body["claim_token"] = claim_token
        try:
            await self._request(
                "PATCH", f"/work/queue/{work_item_id}/cancel", json=body
            )
        except QueueConflictError:
            return False
        return True

    async def upsert_consumer(
        self,
        *,
        consumer_id: str,
        kind: WorkItemKind,
        startup_check: dict[str, Any] | None = None,
        status: ConsumerStatus = "starting",
        image_tag: str | None = None,
        hostname: str | None = None,
    ) -> dict[str, Any]:
        """POST /work/queue/consumers — register the consumer row."""
        body: dict[str, Any] = {
            "id": consumer_id,
            "kind": kind,
            "status": status,
        }
        if startup_check is not None:
            body["startup_check"] = startup_check
        if image_tag is not None:
            body["image_tag"] = image_tag
        if hostname is not None:
            body["hostname"] = hostname
        resp = await self._request("POST", "/work/queue/consumers", json=body)
        if resp.status_code in (200, 201):
            return resp.json()  # type: ignore[no-any-return]
        raise QueueClientError(
            f"upsert_consumer returned {resp.status_code}: {resp.text[:200]}"
        )

    async def update_consumer(
        self,
        *,
        consumer_id: str,
        status: ConsumerStatus | None = None,
        startup_check: dict[str, Any] | None = None,
    ) -> None:
        """PATCH /work/queue/consumers/{id} — flip status / bump last_seen_at."""
        body: dict[str, Any] = {}
        if status is not None:
            body["status"] = status
        if startup_check is not None:
            body["startup_check"] = startup_check
        await self._request(
            "PATCH", f"/work/queue/consumers/{consumer_id}", json=body
        )

    async def heartbeat_consumer(self, consumer_id: str) -> None:
        """PATCH /work/queue/consumers/{id} with no body — bumps last_seen_at.

        Matches the worker's branch in ``update_consumer`` where a body with
        all-None fields hits ``heartbeat_consumer`` server-side.
        """
        await self._request(
            "PATCH", f"/work/queue/consumers/{consumer_id}", json={}
        )


__all__ = [
    "QueueAuthError",
    "QueueClient",
    "QueueClientError",
    "QueueConflictError",
    "QueueServerError",
]
