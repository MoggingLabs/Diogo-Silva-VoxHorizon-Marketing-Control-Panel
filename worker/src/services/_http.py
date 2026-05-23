"""Resilient async HTTP base for the worker's outbound integrations (P5.7 / #370).

A thin wrapper around ``httpx.AsyncClient`` that adds the three things every
external connector (GHL, and later Meta/Drive recorders) needs to survive a
flaky upstream without hammering it:

  1. **Retry with exponential backoff + full jitter.** Only *transient*
     failures are retried — the retryable HTTP status set is
     ``{408, 429, 500, 502, 503, 504}`` plus connect/read timeouts and
     transport-level connect errors. 4xx (except 429) are PERMANENT and never
     retried. ``Retry-After`` (delta-seconds or HTTP-date) is honored when the
     server sends it. Capped at ``max_attempts`` (~4 by default).
  2. **A per-host circuit breaker.** After ``failure_threshold`` consecutive
     failures to a host the breaker OPENS and fast-fails further calls for
     ``recovery_timeout`` seconds (raising :class:`CircuitOpenError`, a
     ``RetryableError`` subtype), then allows a single HALF-OPEN probe: a
     success CLOSES it, a failure re-OPENS it. This keeps one dead upstream
     from blocking the worker's request budget.
  3. **Structured ``structlog`` logging with a correlation id.** Every attempt
     logs under a stable ``correlation_id`` (the architecture's per-call /
     ``pipeline_id`` trace id) so a retried call is one greppable thread.

Error model (typed so callers branch on intent, not on httpx internals):

  * :class:`RetryableError`  — transient; exhausted after ``max_attempts`` or a
    breaker fast-fail. Subtypes: :class:`CircuitOpenError`.
  * :class:`PermanentError` — non-retryable (4xx except 429, or a programming
    error). Caller should not retry.

Both carry the optional ``status_code`` and parsed ``payload`` so a connector
(e.g. :mod:`services.ghl`) can re-raise its own typed error with context.

The breaker state lives on the :class:`ResilientHttpClient` instance, so it is
per-client (one connector = one breaker registry, keyed by host). Tests drive
the whole thing through ``httpx.MockTransport`` — no sockets, no sleeps (the
sleep function is injectable via ``sleep``).
"""

from __future__ import annotations

import asyncio
import random
import time
import uuid
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass, field
from email.utils import parsedate_to_datetime
from typing import Any

import httpx
import structlog


log = structlog.get_logger(__name__)


# HTTP status codes that represent a *transient* server condition and are safe
# to retry. 429 (Too Many Requests) is the one 4xx we retry — every other 4xx
# is a client error (bad request, auth, not found) and retrying is pointless.
RETRYABLE_STATUS: frozenset[int] = frozenset({408, 429, 500, 502, 503, 504})

# Default retry envelope. ~4 attempts = 1 initial + 3 retries.
DEFAULT_MAX_ATTEMPTS = 4
DEFAULT_BACKOFF_BASE_S = 0.5
DEFAULT_BACKOFF_MAX_S = 30.0

# Default circuit-breaker envelope (per host).
DEFAULT_FAILURE_THRESHOLD = 5
DEFAULT_RECOVERY_TIMEOUT_S = 30.0


# ---------------------------------------------------------------------------
# Typed errors
# ---------------------------------------------------------------------------


class HttpClientError(RuntimeError):
    """Base for every error this module raises.

    ``status_code`` is set when the failure originated in an HTTP response;
    ``payload`` is the parsed JSON body when one was available (else ``None``).
    """

    def __init__(
        self,
        message: str,
        *,
        status_code: int | None = None,
        payload: Any | None = None,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.payload = payload


class RetryableError(HttpClientError):
    """A transient failure — surfaced after retries are exhausted.

    Raised when every attempt hit a retryable condition (retryable status,
    timeout, or connect error) and the attempt budget ran out, or when the
    circuit breaker fast-fails (see :class:`CircuitOpenError`).
    """


class PermanentError(HttpClientError):
    """A non-retryable failure — a 4xx (except 429) or a programming error."""


class CircuitOpenError(RetryableError):
    """The per-host circuit breaker is OPEN; the call was fast-failed.

    A subtype of :class:`RetryableError` because, from the caller's view, the
    upstream is transiently unavailable — a later call (after the recovery
    window) may succeed.
    """


# ---------------------------------------------------------------------------
# Circuit breaker
# ---------------------------------------------------------------------------


# Breaker states.
_CLOSED = "closed"
_OPEN = "open"
_HALF_OPEN = "half_open"


@dataclass
class _Breaker:
    """One host's circuit-breaker state machine.

    ``closed``   — calls flow; consecutive failures count up.
    ``open``     — calls fast-fail until ``recovery_timeout`` elapses since the
                   trip, then the next call is allowed as a half-open probe.
    ``half_open``— a single probe is in flight; success → closed, failure →
                   open (the timer restarts).
    """

    failure_threshold: int
    recovery_timeout_s: float
    monotonic: Callable[[], float]
    state: str = _CLOSED
    consecutive_failures: int = 0
    opened_at: float | None = None

    def allow(self) -> bool:
        """Return ``True`` if a call may proceed; flip OPEN→HALF_OPEN if due."""
        if self.state == _OPEN:
            assert self.opened_at is not None
            if self.monotonic() - self.opened_at >= self.recovery_timeout_s:
                # Recovery window elapsed — let exactly one probe through.
                self.state = _HALF_OPEN
                return True
            return False
        # closed or half_open both permit a call (half_open = the single probe).
        return True

    def record_success(self) -> None:
        """A call succeeded — reset to fully closed."""
        self.state = _CLOSED
        self.consecutive_failures = 0
        self.opened_at = None

    def record_failure(self) -> None:
        """A call failed — count it and trip OPEN at/over the threshold.

        A failure during the HALF_OPEN probe always re-opens immediately
        (the upstream is still sick), regardless of the running count.
        """
        if self.state == _HALF_OPEN:
            self._trip()
            return
        self.consecutive_failures += 1
        if self.consecutive_failures >= self.failure_threshold:
            self._trip()

    def _trip(self) -> None:
        self.state = _OPEN
        self.opened_at = self.monotonic()


# ---------------------------------------------------------------------------
# Retry helpers (pure — unit-testable in isolation)
# ---------------------------------------------------------------------------


def parse_retry_after(value: str | None, *, now: float | None = None) -> float | None:
    """Parse a ``Retry-After`` header into a non-negative delay in seconds.

    Accepts either delta-seconds (``"120"``) or an HTTP-date
    (``"Wed, 21 Oct 2026 07:28:00 GMT"``). Returns ``None`` when the header is
    absent or unparseable, and clamps negative/past values to ``0.0``.

    ``now`` (epoch seconds) is injectable so the HTTP-date branch is
    deterministic in tests.
    """
    if value is None:
        return None
    raw = value.strip()
    if not raw:
        return None
    # delta-seconds form.
    try:
        return max(0.0, float(int(raw)))
    except ValueError:
        pass
    # HTTP-date form.
    try:
        dt = parsedate_to_datetime(raw)
    except (TypeError, ValueError):
        return None
    if dt is None:  # pragma: no cover - defensive; modern stdlib raises instead
        return None
    target = dt.timestamp()
    current = time.time() if now is None else now
    return max(0.0, target - current)


def backoff_delay(
    attempt: int,
    *,
    base: float = DEFAULT_BACKOFF_BASE_S,
    cap: float = DEFAULT_BACKOFF_MAX_S,
    rng: Callable[[], float] = random.random,
) -> float:
    """Exponential backoff with **full jitter**.

    ``attempt`` is 1-based (the delay *before* the 2nd attempt is ``attempt=1``).
    The uncapped window is ``base * 2**(attempt-1)``; full jitter then picks a
    uniform value in ``[0, min(cap, window)]`` (AWS "Exponential Backoff And
    Jitter"). ``rng`` is injectable for deterministic tests.
    """
    window = min(cap, base * (2 ** max(0, attempt - 1)))
    return rng() * window


# ---------------------------------------------------------------------------
# Resilient client
# ---------------------------------------------------------------------------


# Outcome classification for one attempt.
_OUTCOME_SUCCESS = "success"  # a non-error response — return it to the caller.
_OUTCOME_RETRYABLE = "retryable"  # transient — back off and retry.
_OUTCOME_PERMANENT = "permanent"  # non-retryable error — raise immediately.


@dataclass
class _Attempt:
    """Outcome of one HTTP attempt, used to decide retry vs raise."""

    outcome: str
    response: httpx.Response | None = None
    error: Exception | None = None
    status_code: int | None = None
    retry_after_s: float | None = None
    payload: Any | None = None


class ResilientHttpClient:
    """An ``httpx.AsyncClient`` wrapper with retry + breaker + correlation logs.

    Construct once per connector (it owns the breaker registry). Each
    :meth:`request` call:

      * checks the per-host breaker (fast-fails with :class:`CircuitOpenError`
        when OPEN),
      * issues the request,
      * on a retryable outcome sleeps ``backoff_delay`` (or ``Retry-After``)
        and retries up to ``max_attempts``,
      * on a permanent outcome raises :class:`PermanentError` immediately,
      * logs every attempt under a stable ``correlation_id``.

    The underlying ``httpx.AsyncClient`` is created lazily and reused; pass a
    ``transport`` (``httpx.MockTransport``) to drive it in tests. ``sleep`` is
    injectable so tests don't actually wait, and ``monotonic`` so the breaker's
    recovery clock is deterministic.
    """

    def __init__(
        self,
        *,
        base_url: str = "",
        headers: Mapping[str, str] | None = None,
        timeout_s: float = 30.0,
        max_attempts: int = DEFAULT_MAX_ATTEMPTS,
        backoff_base_s: float = DEFAULT_BACKOFF_BASE_S,
        backoff_max_s: float = DEFAULT_BACKOFF_MAX_S,
        failure_threshold: int = DEFAULT_FAILURE_THRESHOLD,
        recovery_timeout_s: float = DEFAULT_RECOVERY_TIMEOUT_S,
        transport: httpx.AsyncBaseTransport | None = None,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
        monotonic: Callable[[], float] = time.monotonic,
        rng: Callable[[], float] = random.random,
    ) -> None:
        self._base_url = base_url
        self._headers = dict(headers or {})
        self._timeout_s = timeout_s
        self._max_attempts = max(1, max_attempts)
        self._backoff_base_s = backoff_base_s
        self._backoff_max_s = backoff_max_s
        self._failure_threshold = max(1, failure_threshold)
        self._recovery_timeout_s = recovery_timeout_s
        self._transport = transport
        self._sleep = sleep
        self._monotonic = monotonic
        self._rng = rng

        self._client: httpx.AsyncClient | None = None
        self._breakers: dict[str, _Breaker] = {}

    # -- lifecycle ---------------------------------------------------------

    def _ensure_client(self) -> httpx.AsyncClient:
        if self._client is None:
            kwargs: dict[str, Any] = {
                "base_url": self._base_url,
                "headers": self._headers,
                "timeout": self._timeout_s,
            }
            if self._transport is not None:
                kwargs["transport"] = self._transport
            self._client = httpx.AsyncClient(**kwargs)
        return self._client

    async def aclose(self) -> None:
        """Close the underlying client (idempotent)."""
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    async def __aenter__(self) -> "ResilientHttpClient":
        self._ensure_client()
        return self

    async def __aexit__(self, *_exc: object) -> None:
        await self.aclose()

    # -- breaker registry --------------------------------------------------

    def _breaker_for(self, host: str) -> _Breaker:
        breaker = self._breakers.get(host)
        if breaker is None:
            breaker = _Breaker(
                failure_threshold=self._failure_threshold,
                recovery_timeout_s=self._recovery_timeout_s,
                monotonic=self._monotonic,
            )
            self._breakers[host] = breaker
        return breaker

    def breaker_state(self, host: str) -> str:
        """Inspect a host's breaker state (for /work/metrics + tests)."""
        return self._breaker_for(host).state

    # -- the core request loop --------------------------------------------

    async def request(
        self,
        method: str,
        url: str,
        *,
        correlation_id: str | None = None,
        **kwargs: Any,
    ) -> httpx.Response:
        """Issue ``method url`` with retry + breaker, returning the response.

        Returns the first non-retryable success response (2xx/3xx, or any
        non-retryable status the caller asked us not to treat as an error —
        this method only raises on the *retryable-exhausted* and *permanent*
        paths; status interpretation beyond retry is the caller's job).

        Raises :class:`PermanentError` on a non-retryable 4xx (except 429) or a
        programming error, :class:`CircuitOpenError` when the breaker is open,
        and :class:`RetryableError` when the retry budget is exhausted.
        """
        cid = correlation_id or uuid.uuid4().hex
        client = self._ensure_client()
        full_url = httpx.URL(client.base_url).join(url) if client.base_url else httpx.URL(url)
        host = full_url.host or "unknown"
        breaker = self._breaker_for(host)

        last: _Attempt | None = None
        for attempt in range(1, self._max_attempts + 1):
            if not breaker.allow():
                log.warning(
                    "http_circuit_open",
                    correlation_id=cid,
                    host=host,
                    method=method,
                    attempt=attempt,
                )
                raise CircuitOpenError(
                    f"circuit breaker open for host {host!r}",
                )

            last = await self._attempt(client, method, url, cid, attempt, **kwargs)

            if last.outcome == _OUTCOME_SUCCESS:
                assert last.response is not None
                breaker.record_success()
                return last.response

            # A failure (retryable or permanent) — count it against the breaker.
            breaker.record_failure()

            if last.outcome == _OUTCOME_PERMANENT:
                # Permanent error path (e.g. 4xx except 429): raise now.
                raise PermanentError(
                    self._permanent_message(method, url, last),
                    status_code=last.status_code,
                    payload=last.payload,
                ) from last.error

            if attempt >= self._max_attempts:
                break

            delay = last.retry_after_s
            if delay is None:
                delay = backoff_delay(
                    attempt,
                    base=self._backoff_base_s,
                    cap=self._backoff_max_s,
                    rng=self._rng,
                )
            log.info(
                "http_retry",
                correlation_id=cid,
                host=host,
                method=method,
                attempt=attempt,
                status_code=last.status_code,
                delay_s=round(delay, 4),
                reason=("status" if last.response is not None else "transport"),
            )
            await self._sleep(delay)

        # Budget exhausted on a retryable condition.
        assert last is not None
        log.warning(
            "http_retries_exhausted",
            correlation_id=cid,
            host=host,
            method=method,
            attempts=self._max_attempts,
            status_code=last.status_code,
        )
        raise RetryableError(
            f"{method} {url} failed after {self._max_attempts} attempts",
            status_code=last.status_code,
            payload=last.payload,
        ) from last.error

    async def _attempt(
        self,
        client: httpx.AsyncClient,
        method: str,
        url: str,
        cid: str,
        attempt: int,
        **kwargs: Any,
    ) -> _Attempt:
        """Run one HTTP attempt and classify its outcome."""
        try:
            resp = await client.request(method, url, **kwargs)
        except (httpx.TimeoutException, httpx.ConnectError, httpx.ReadError) as e:
            # Transport-level transient: connect/read failures + timeouts.
            log.info(
                "http_attempt_transport_error",
                correlation_id=cid,
                method=method,
                attempt=attempt,
                error=str(e),
                error_type=type(e).__name__,
            )
            return _Attempt(outcome=_OUTCOME_RETRYABLE, error=e)
        except httpx.HTTPError as e:
            # Any other httpx error (e.g. a malformed request) — permanent.
            log.warning(
                "http_attempt_permanent_error",
                correlation_id=cid,
                method=method,
                attempt=attempt,
                error=str(e),
                error_type=type(e).__name__,
            )
            return _Attempt(outcome=_OUTCOME_PERMANENT, error=e)

        status = resp.status_code
        if status in RETRYABLE_STATUS:
            outcome = _OUTCOME_RETRYABLE
        elif status >= 400:
            # Any other 4xx/5xx is a non-retryable error (e.g. 400/401/403/404).
            outcome = _OUTCOME_PERMANENT
        else:
            outcome = _OUTCOME_SUCCESS
        retry_after = (
            parse_retry_after(resp.headers.get("Retry-After"))
            if outcome == _OUTCOME_RETRYABLE
            else None
        )
        log.info(
            "http_attempt",
            correlation_id=cid,
            method=method,
            attempt=attempt,
            status_code=status,
            outcome=outcome,
        )
        return _Attempt(
            outcome=outcome,
            response=resp,
            status_code=status,
            retry_after_s=retry_after,
            payload=_safe_json(resp),
        )

    @staticmethod
    def _permanent_message(method: str, url: str, attempt: _Attempt) -> str:
        if attempt.status_code is not None:
            return f"{method} {url} returned non-retryable {attempt.status_code}"
        return f"{method} {url} failed with a permanent error: {attempt.error}"

    # -- ergonomic verb shortcuts -----------------------------------------

    async def get(self, url: str, **kwargs: Any) -> httpx.Response:
        return await self.request("GET", url, **kwargs)

    async def post(self, url: str, **kwargs: Any) -> httpx.Response:
        return await self.request("POST", url, **kwargs)


def _safe_json(resp: httpx.Response) -> Any | None:
    """Parse a response body as JSON; return ``None`` on a non-JSON body."""
    try:
        return resp.json()
    except (ValueError, UnicodeDecodeError):
        return None
