"""Operator-controlled approval mode cache for voxhorizon-approvals.

The dashboard's Settings tab can flip the plugin's behavior between
three modes (see ``db/migrations/0009_approval_mode.sql``):

  * ``ASK``          — long-poll the dashboard for an operator decision
  * ``AUTO_APPROVE`` — allow without asking, TTL-bounded (1h .. 24h)
  * ``HALT``         — block every approval-needing tool

The plugin's ``pre_tool_call`` hook calls :func:`fetch_mode` at the TOP
of every call BEFORE allowlist / cache lookups. To keep the hot path
under <1ms we cache the result for :data:`MODE_CACHE_TTL_S` (5s) in
a module-level dict; the dashboard's mode flip is at-most-5s-delayed
which the spec accepts.

Fail-mode
---------
Any error — HTTP, timeout, JSON parse, expired AUTO_APPROVE — degrades
to ``ASK``. That's the safer default: the operator still gets the
prompt, and a misbehaving worker can't trigger silent auto-approve.

The cached row's ``expires_at`` is checked locally so an AUTO_APPROVE
TTL expiry doesn't require a worker round-trip — once the row's
``expires_at`` is in the past, we treat it as ``ASK`` until the next
refresh.
"""

from __future__ import annotations

import os
import time
from dataclasses import dataclass
from datetime import datetime, timezone

import httpx


#: Cache TTL in seconds. 5s is the spec's contract; small enough that
#: the dashboard's flip propagates "quickly", large enough that the
#: plugin's hot path doesn't slam the worker on every tool call.
MODE_CACHE_TTL_S: float = 5.0

#: Default HTTP timeout for the mode probe. Aggressive — if the worker
#: takes more than 300ms to answer we'd rather degrade to ASK than
#: stall a tool call. The route is a pure-Supabase SELECT so 300ms
#: is generous for a healthy stack.
DEFAULT_FETCH_TIMEOUT_S: float = 0.3

#: Worker path. Must match the route declared in
#: ``worker/src/routes/hermes_approval_mode.py``.
MODE_PATH = "/work/hermes/approval-mode"

#: Env var names — re-shared with the long-poll client.
ENV_WORKER_URL = "VOXHORIZON_APPROVAL_WORKER_URL"
ENV_APPROVAL_TOKEN = "VOXHORIZON_APPROVAL_TOKEN"


# ---------------------------------------------------------------------------
# Data shape
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ModeState:
    """The plugin's view of the current mode.

    ``effective_mode`` is what the plugin actually acts on — it differs
    from ``mode`` when an AUTO_APPROVE row has expired (the raw value
    is still AUTO_APPROVE but the effective behavior is ASK).
    """

    mode: str
    expires_at: str | None
    set_by: str | None
    set_at: str
    note: str | None

    @property
    def effective_mode(self) -> str:
        """Return the mode the plugin should act on right now.

        Implements the "expired AUTO_APPROVE drops back to ASK" rule
        from the spec without a worker round-trip.
        """
        if self.mode != "AUTO_APPROVE":
            return self.mode
        if not self.expires_at:
            # AUTO_APPROVE without an expiry is malformed (the DB
            # constraint forbids it). Fail-safe: treat as ASK.
            return "ASK"
        try:
            # The worker returns ISO-8601 UTC. ``fromisoformat`` accepts
            # the ``+00:00`` suffix Supabase returns; we don't strip Z
            # because the worker never emits it.
            deadline = datetime.fromisoformat(self.expires_at)
        except ValueError:
            return "ASK"
        # Ensure both sides are timezone-aware so the comparison is
        # well-defined.
        if deadline.tzinfo is None:
            deadline = deadline.replace(tzinfo=timezone.utc)
        if deadline <= datetime.now(timezone.utc):
            return "ASK"
        return "AUTO_APPROVE"


# ---------------------------------------------------------------------------
# Cache + fetch
# ---------------------------------------------------------------------------


#: Module-level cache slot. Tuple of ``(monotonic_ts, ModeState)``.
#: A miss / expiry refreshes from the worker.
_cache: dict[str, tuple[float, ModeState]] = {}

#: Safe default returned on missing config / fetch failure.
_DEFAULT_ASK = ModeState(
    mode="ASK",
    expires_at=None,
    set_by=None,
    set_at="",
    note=None,
)


def _resolve_target() -> tuple[str, str] | None:
    """Read worker URL + token from env. Returns ``None`` if either missing."""
    raw_url = os.environ.get(ENV_WORKER_URL, "").strip().rstrip("/")
    raw_token = os.environ.get(ENV_APPROVAL_TOKEN, "").strip()
    if not raw_url or not raw_token:
        return None
    return f"{raw_url}{MODE_PATH}", raw_token


def _now() -> float:
    """Indirection so tests can monkey-patch the clock."""
    return time.monotonic()


def clear_cache() -> None:
    """Drop the in-process cache. Used by tests."""
    _cache.clear()


def fetch_mode(
    *,
    timeout: float = DEFAULT_FETCH_TIMEOUT_S,
    http_client: httpx.Client | None = None,
) -> ModeState:
    """Return the current mode, hitting the worker at most once per 5s.

    Synchronous — Hermes invokes the ``pre_tool_call`` hook (which calls
    this) without awaiting, so a blocking probe is the correct contract.

    Args:
        timeout: HTTP read timeout. Default 300ms; the worker is local
            so this should rarely be the limiting factor.
        http_client: Inject a pre-built client for tests. When ``None``
            we build a one-shot client per refresh — that's wasteful
            in the long run, but the cache means refreshes happen at
            most every 5s, so creating ~12 clients per minute is
            negligible. The plugin keeps its own long-lived client
            for the long-poll route; we deliberately don't reuse it
            so a long-poll hang can't starve the mode probe.

    Returns:
        A :class:`ModeState`. On any error, returns the cached value
        if present, otherwise the ASK default.
    """
    now = _now()
    cached = _cache.get("singleton")
    if cached is not None:
        ts, state = cached
        if now - ts < MODE_CACHE_TTL_S:
            return state

    target = _resolve_target()
    if target is None:
        # Env not set — degrade to ASK and DON'T cache, so a later
        # init that populates the env does refresh immediately.
        return _DEFAULT_ASK

    url, token = target
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/json",
    }

    owns_client = http_client is None
    client = http_client or httpx.Client(
        timeout=httpx.Timeout(timeout)
    )
    try:
        try:
            response = client.get(url, headers=headers, timeout=timeout)
        except (
            httpx.TimeoutException,
            httpx.HTTPError,
        ):
            # Any transport-level failure → fall back to last-known cached
            # value if we have one; otherwise degrade to ASK. Don't
            # update the cache so we retry on the next call.
            if cached is not None:
                return cached[1]
            return _DEFAULT_ASK

        if response.status_code != 200:
            # 4xx/5xx — same fail-to-ASK behavior. Caching a failure
            # would mean a one-shot worker blip would silence the
            # operator UI for 5s.
            if cached is not None:
                return cached[1]
            return _DEFAULT_ASK

        try:
            payload = response.json()
        except ValueError:
            if cached is not None:
                return cached[1]
            return _DEFAULT_ASK
    finally:
        if owns_client:
            client.close()

    if not isinstance(payload, dict):
        return _DEFAULT_ASK

    raw_mode = payload.get("mode")
    if raw_mode not in ("ASK", "AUTO_APPROVE", "HALT"):
        # Unknown mode → fail-to-ASK rather than honor a typo.
        return _DEFAULT_ASK

    expires_at = payload.get("expires_at")
    state = ModeState(
        mode=raw_mode,
        expires_at=(
            str(expires_at) if isinstance(expires_at, str) else None
        ),
        set_by=(
            str(payload.get("set_by"))
            if isinstance(payload.get("set_by"), str)
            else None
        ),
        set_at=(
            str(payload.get("set_at"))
            if isinstance(payload.get("set_at"), str)
            else ""
        ),
        note=(
            str(payload.get("note"))
            if isinstance(payload.get("note"), str)
            else None
        ),
    )
    _cache["singleton"] = (now, state)
    return state


__all__ = [
    "DEFAULT_FETCH_TIMEOUT_S",
    "ENV_APPROVAL_TOKEN",
    "ENV_WORKER_URL",
    "MODE_CACHE_TTL_S",
    "MODE_PATH",
    "ModeState",
    "clear_cache",
    "fetch_mode",
]
