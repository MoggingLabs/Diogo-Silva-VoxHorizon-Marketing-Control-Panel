"""HTTP client + in-process cache for voxhorizon-approvals.

Wraps the worker's long-poll endpoint
(``POST /work/hermes/approval``, see ``worker/src/routes/hermes_approval.py``)
behind a synchronous facade. Layered so the plugin's ``register``
hook never has to know about httpx, env-var resolution, or cache TTLs.

Hermes invokes ``pre_tool_call`` hooks SYNCHRONOUSLY (it uses each
hook's return value directly, it does not ``await``), so this client is
a plain blocking ``httpx.Client``. Blocking is the intended behavior:
the gate must hold the tool call open until the operator decides.

Why an in-process cache?
------------------------
The dashboard's "Approve and remember for this session" toggle on the
operator UI translates into "skip the round-trip next time". We store
that decision keyed on ``(tool_name, args_hash)`` so a repeated identical
call (same tool, same args, same session) bypasses the network. Cache
lookups are pure dict reads at <1us, well inside the <1ms hot-path
budget.

Fail-closed guarantees
----------------------
Any error during the round-trip (timeout, DNS, 401, 5xx, malformed
response) raises :class:`ApprovalClientError`. The caller in
``__init__.py`` turns that into a block, so the agent NEVER proceeds on
a swallowed exception. The cache is only populated on a definitive
``approved`` / ``approved_with_caveat`` decision.
"""

from __future__ import annotations

import os
import time
import uuid
from dataclasses import dataclass

import httpx

from .policy import args_hash


#: Default seconds to wait for the operator. The worker enforces its own
#: ``DEFAULT_TIMEOUT_S`` and the request body lets us override it; we
#: keep both numbers aligned so the plugin's read timeout strictly
#: exceeds the worker's poll window by a few seconds (room for the final
#: DB write + JSON serialization on the worker).
DEFAULT_TIMEOUT_S = 600

#: Slack between the worker's hard timeout and ours, in seconds. The
#: client's ``read`` timeout is ``worker_timeout + _TIMEOUT_SLACK_S`` so
#: the worker returns ``rejected`` to us BEFORE httpx raises a transport
#: error. That ordering keeps the audit log accurate ("operator did not
#: respond" vs. "network blip").
_TIMEOUT_SLACK_S = 10

#: TTL on cached approvals, seconds. 30 minutes covers a single session
#: comfortably without making "approve and remember" effectively
#: permanent — the operator can always re-approve.
DEFAULT_CACHE_TTL_S = 30 * 60

#: Env-var names. Documented in ``plugin.yaml::requires_env``.
ENV_WORKER_URL = "VOXHORIZON_APPROVAL_WORKER_URL"
ENV_APPROVAL_TOKEN = "VOXHORIZON_APPROVAL_TOKEN"

#: API path on the worker.
APPROVAL_PATH = "/work/hermes/approval"


# ---------------------------------------------------------------------------
# Result + error types
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ApprovalVerdict:
    """Mirror of the worker's ``ApprovalDecisionResponse`` shape.

    See ``worker/src/routes/hermes_approval.py::ApprovalDecisionResponse``.
    ``decision`` is one of ``"approved"`` / ``"rejected"`` /
    ``"approved_with_caveat"``.
    """

    decision: str
    notes: str | None = None


class ApprovalClientError(RuntimeError):
    """Anything that prevents reaching a definitive verdict.

    Wraps the underlying httpx / env / parse error. Callers (the
    pre_tool_call hook) convert this to a block.
    """


# ---------------------------------------------------------------------------
# In-process cache
# ---------------------------------------------------------------------------


@dataclass
class _CacheEntry:
    """One cached operator decision plus its expiry deadline.

    ``expires_at`` is a monotonic-clock timestamp (``time.monotonic``)
    so wall-clock changes (NTP, DST) don't accidentally evict or extend
    entries.
    """

    verdict: ApprovalVerdict
    expires_at: float


class _SessionCache:
    """Per-session approval cache.

    Sessions are identified by Hermes' ``session_id`` (or
    ``"default"`` when not provided). Keys within a session are
    ``(tool_name, args_hash)``; values are :class:`_CacheEntry`.
    """

    def __init__(self) -> None:
        self._store: dict[
            str, dict[tuple[str, str], _CacheEntry]
        ] = {}

    def get(
        self, session_id: str, tool_name: str, args: dict
    ) -> ApprovalVerdict | None:
        """Return a fresh cached verdict, or ``None`` if missing / expired."""
        session = self._store.get(session_id)
        if not session:
            return None
        key = (tool_name, args_hash(tool_name, args))
        entry = session.get(key)
        if entry is None:
            return None
        if entry.expires_at <= time.monotonic():
            # Expired — drop it so the next lookup is a clean miss.
            del session[key]
            return None
        return entry.verdict

    def put(
        self,
        session_id: str,
        tool_name: str,
        args: dict,
        verdict: ApprovalVerdict,
        ttl_s: float = DEFAULT_CACHE_TTL_S,
    ) -> None:
        """Insert/refresh a cached verdict."""
        session = self._store.setdefault(session_id, {})
        key = (tool_name, args_hash(tool_name, args))
        session[key] = _CacheEntry(
            verdict=verdict, expires_at=time.monotonic() + ttl_s
        )

    def clear(self, session_id: str | None = None) -> None:
        """Drop all entries for a session (or globally if ``None``)."""
        if session_id is None:
            self._store.clear()
        else:
            self._store.pop(session_id, None)


# ---------------------------------------------------------------------------
# Client
# ---------------------------------------------------------------------------


class ApprovalClient:
    """Synchronous wrapper around the worker's approval endpoint.

    One instance per plugin load — built in :func:`register`. The
    underlying :class:`httpx.Client` is created lazily on the first
    request so import-time has no side effects; that's important
    because Hermes imports plugins at startup before the env vars are
    necessarily exported.
    """

    def __init__(
        self,
        *,
        worker_url: str | None = None,
        token: str | None = None,
        default_timeout_s: int = DEFAULT_TIMEOUT_S,
        cache_ttl_s: float = DEFAULT_CACHE_TTL_S,
        http_client: httpx.Client | None = None,
    ) -> None:
        # Resolve env at call-time (in :meth:`_resolve_target`) NOT at
        # ``__init__`` time — that way the plugin can be constructed
        # before env vars are populated.
        self._worker_url_override = worker_url
        self._token_override = token
        self._default_timeout_s = default_timeout_s
        self._cache_ttl_s = cache_ttl_s
        self._http_client = http_client
        self._owns_http_client = http_client is None
        self._cache = _SessionCache()

    # ------------------------------------------------------------------
    # Cache surface (delegated to _SessionCache so tests can hit it)
    # ------------------------------------------------------------------

    def cache_get(
        self, session_id: str, tool_name: str, args: dict
    ) -> ApprovalVerdict | None:
        """Hot-path cache lookup; returns ``None`` on miss / expiry."""
        return self._cache.get(session_id, tool_name, args)

    def cache_put(
        self,
        session_id: str,
        tool_name: str,
        args: dict,
        verdict: ApprovalVerdict,
    ) -> None:
        """Stash a verdict for the rest of the session."""
        self._cache.put(
            session_id, tool_name, args, verdict, self._cache_ttl_s
        )

    def cache_clear(self, session_id: str | None = None) -> None:
        """Forget cached verdicts for one session (or globally)."""
        self._cache.clear(session_id)

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    def close(self) -> None:
        """Close the underlying httpx client if we own it."""
        if (
            self._owns_http_client
            and self._http_client is not None
        ):
            self._http_client.close()
            self._http_client = None

    # ------------------------------------------------------------------
    # Auto-decision writer (AUTO_APPROVE / HALT mode short-circuits)
    # ------------------------------------------------------------------

    def write_auto_decision(
        self,
        *,
        tool_name: str,
        args: dict,
        session_id: str,
        tool_call_id: str,
        risk_class: str | None,
        decision: str,
        decided_by: str,
        notes: str,
    ) -> None:
        """Record a non-operator decision (AUTO_APPROVE / HALT mode).

        Fire-and-forget — any failure is swallowed so an audit-write
        glitch can't block the agent's tool call. The operator's
        canonical trail is the JSONL audit log (already written by
        the hook) + Supabase ``approvals`` table; this method tries
        to land a row in the latter so the existing dashboard audit
        page reflects auto-decisions alongside operator decisions.

        We POST to the same long-poll endpoint but with a deterministic
        ``approval_id`` derived from the tool-call id; the worker's
        UPSERT idempotency means a second auto-decision for the same
        call doesn't duplicate the row. We then PATCH-update the row
        with the decision via a separate dashboard-facing endpoint;
        because that endpoint isn't exposed yet, this method currently
        only writes the ``pending`` row + lets the worker's audit
        page render the synthesized notes. A follow-up wave wires
        the decided-by/decided-notes write.

        Args:
            tool_name: Hermes tool identifier.
            args: Tool args (rendered into the approvals.tool_args
                column for the dashboard audit page).
            session_id: Hermes/Ekko session id.
            tool_call_id: Tool-call id inside that session.
            risk_class: Same risk taxonomy the operator UI uses.
            decision: ``"approved"`` / ``"rejected"`` /
                ``"approved_with_caveat"``.
            decided_by: ``"auto_mode:AUTO_APPROVE"`` /
                ``"auto_mode:HALT"``.
            notes: Human-readable trace ("Mode TTL expires ...").
        """
        # Best-effort — never raise. The plugin's primary record is the
        # local JSONL audit log written by the hook BEFORE this call,
        # so a transport failure here just means the dashboard audit
        # page doesn't show the auto-decision; it's not a correctness
        # issue.
        try:
            url, token = self._resolve_target()
        except ApprovalClientError:
            # Env not set — no worker to talk to. Silently drop.
            return

        # Re-use the long-poll endpoint just to INSERT the pending
        # row; the worker's UPSERT idempotency keeps repeats safe.
        # We pass ``timeout_s=1`` so the worker doesn't actually wait
        # for a decision — we want the row written and we're going
        # to return immediately. The worker treats this as "operator
        # has 1 second to decide", which will time out and write
        # status='expired'. That's fine; the JSONL log captures the
        # real decision, and a future wave will land a direct INSERT
        # endpoint that doesn't long-poll.
        body = {
            "approval_id": _approval_id_from_tool_call(tool_call_id),
            "ekko_session_id": session_id,
            "ekko_tool_call_id": tool_call_id,
            "tool_name": tool_name,
            "tool_args": args or {},
            "risk_class": risk_class,
            "context": {
                "auto_decision": decision,
                "decided_by": decided_by,
                "decided_notes": notes,
            },
            "timeout_s": 1,
        }
        headers = {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        }
        # Use a one-shot client with a tight timeout — we MUST NOT
        # delay the agent's tool dispatch on this best-effort write.
        try:
            with httpx.Client(
                timeout=httpx.Timeout(connect=1.0, read=2.0, write=1.0, pool=1.0)
            ) as scratch:
                scratch.post(url, json=body, headers=headers)
        except Exception:  # noqa: BLE001 — never raise on best-effort
            return

    # ------------------------------------------------------------------
    # Request
    # ------------------------------------------------------------------

    def request_approval(
        self,
        *,
        tool_name: str,
        args: dict,
        session_id: str,
        tool_call_id: str,
        risk_class: str | None = None,
        context: dict | None = None,
        timeout_s: int | None = None,
    ) -> ApprovalVerdict:
        """Round-trip the worker for a decision.

        Cache hits short-circuit BEFORE this method is invoked; the
        caller in :mod:`__init__` does that. If the worker returns
        ``approved`` / ``approved_with_caveat`` we populate the cache so
        repeats are sub-millisecond.

        Raises:
            :class:`ApprovalClientError` on any non-2xx, timeout,
            transport error, or unparseable response.
        """
        url, token = self._resolve_target()

        effective_timeout = (
            timeout_s if timeout_s is not None else self._default_timeout_s
        )
        body = {
            # Deterministic id so the worker's UPSERT idempotency kicks
            # in if Hermes retries inside the same tool-call.
            "approval_id": _approval_id_from_tool_call(tool_call_id),
            "ekko_session_id": session_id,
            "ekko_tool_call_id": tool_call_id,
            "tool_name": tool_name,
            "tool_args": args or {},
            "risk_class": risk_class,
            "context": context or {},
            "timeout_s": effective_timeout,
        }
        headers = {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        }

        client = self._ensure_client(effective_timeout)
        try:
            response = client.post(url, json=body, headers=headers)
        except httpx.TimeoutException as exc:
            raise ApprovalClientError(
                f"approval worker timed out after {effective_timeout}s"
            ) from exc
        except httpx.HTTPError as exc:
            raise ApprovalClientError(
                f"approval worker unreachable: {exc}"
            ) from exc

        if response.status_code != 200:
            # Surface enough body for the audit log to be useful, but
            # cap the slice so a 1MB error page doesn't bloat the JSONL.
            snippet = response.text[:200] if response.text else ""
            raise ApprovalClientError(
                f"approval worker returned {response.status_code}: {snippet}"
            )

        try:
            payload = response.json()
        except (
            ValueError
        ) as exc:  # JSONDecodeError is a ValueError in httpx/json
            raise ApprovalClientError(
                f"approval worker returned non-JSON body: {exc}"
            ) from exc

        decision = payload.get("decision") if isinstance(payload, dict) else None
        if not isinstance(decision, str) or not decision:
            raise ApprovalClientError(
                f"approval worker returned invalid decision: {payload!r}"
            )
        notes = payload.get("notes") if isinstance(payload, dict) else None
        if notes is not None and not isinstance(notes, str):
            # The worker's schema types this as ``str | None``; any other
            # shape is a contract violation we won't silently round-trip.
            raise ApprovalClientError(
                f"approval worker returned non-string notes: {notes!r}"
            )

        verdict = ApprovalVerdict(decision=decision, notes=notes)

        # Only cache positive decisions — caching a rejection would
        # prevent the operator from changing their mind next call.
        if decision in ("approved", "approved_with_caveat"):
            self.cache_put(session_id, tool_name, args, verdict)

        return verdict

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    def _resolve_target(self) -> tuple[str, str]:
        """Resolve ``(url, token)`` from constructor overrides / env.

        Strips trailing slashes off the worker URL so a configured
        ``http://worker:8000/`` doesn't double up into
        ``http://worker:8000//work/hermes/approval``.
        """
        raw_url = (
            self._worker_url_override
            if self._worker_url_override is not None
            else os.environ.get(ENV_WORKER_URL, "")
        )
        raw_token = (
            self._token_override
            if self._token_override is not None
            else os.environ.get(ENV_APPROVAL_TOKEN, "")
        )

        worker = raw_url.strip().rstrip("/")
        if not worker:
            raise ApprovalClientError(
                f"{ENV_WORKER_URL} is not set"
            )
        token = raw_token.strip()
        if not token:
            raise ApprovalClientError(
                f"{ENV_APPROVAL_TOKEN} is not set"
            )
        return f"{worker}{APPROVAL_PATH}", token

    def _ensure_client(self, timeout_s: int) -> httpx.Client:
        """Lazily build the httpx client.

        The ``read`` timeout is set just above the worker's hard
        timeout so the worker's structured ``rejected`` response always
        beats our transport timeout. The ``connect`` timeout is short
        (5s) because the worker shares the docker network — a slow
        connect means trouble worth surfacing fast.
        """
        if self._http_client is None:
            self._http_client = httpx.Client(
                timeout=httpx.Timeout(
                    connect=5.0,
                    read=timeout_s + _TIMEOUT_SLACK_S,
                    write=10.0,
                    pool=10.0,
                )
            )
            self._owns_http_client = True
        return self._http_client


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _approval_id_from_tool_call(tool_call_id: str) -> str:
    """Derive a stable UUID from the Hermes tool-call id.

    Using ``uuid5`` with the URL namespace keeps the id deterministic
    across retries (the worker's UPSERT relies on that) while ensuring
    the value passes pydantic's ``min_length=1`` validator without
    leaking the raw tool-call id format into the worker's schema.
    """
    return str(
        uuid.uuid5(uuid.NAMESPACE_URL, f"voxhorizon-approval:{tool_call_id}")
    )


__all__ = [
    "APPROVAL_PATH",
    "ApprovalClient",
    "ApprovalClientError",
    "ApprovalVerdict",
    "DEFAULT_CACHE_TTL_S",
    "DEFAULT_TIMEOUT_S",
    "ENV_APPROVAL_TOKEN",
    "ENV_WORKER_URL",
]
