"""Worker-side long-poll for the dashboard-driven approval flow (HI-14).

Architecture
------------
The Hermes plugin (running inside the colocated Ekko agent container)
fires a synchronous HTTP request into this worker whenever the agent
loop wants to run a risky tool. The worker:

  1. INSERTs a row into ``approvals`` (status=``pending``) — or, if the
     row already exists because the plugin retried, reuses it. The id
     comes from the plugin and is deterministic on
     ``ekko_tool_call_id``, so retries are idempotent.
  2. Waits for the row's ``status`` to transition to ``decided`` (the
     operator clicked Approve/Reject in the dashboard) OR ``cancelled``
     (the session ended before the operator answered). The wait uses
     polling at :data:`POLL_INTERVAL_S` (250ms); a Realtime fast-path
     is a v1.5 optimization.
  3. Returns the decision to the plugin so it can release / abort the
     tool call.

Concurrency
-----------
A module-level :class:`asyncio.Semaphore` caps in-flight approvals at
:data:`MAX_CONCURRENT`. When the cap is hit the helper
:func:`acquire_slot` returns ``None`` so the route can surface 503; we
never block the caller on the semaphore itself (the plugin would just
sit on its connection while ten earlier requests starve).

Timeout
-------
After :data:`DEFAULT_TIMEOUT_S` seconds (configurable per request) we
flip the row to ``expired`` and return ``rejected``. The expiry write
is conditional on ``status='pending'`` so it never clobbers a decision
that landed during the same tick.

Failure semantics
-----------------
Supabase failures during the initial INSERT or the polling SELECT
propagate as :class:`ApprovalError`. The route translates that into a
502 — Hermes should retry rather than treating the missing decision as
a hard reject.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

import structlog

from ..supabase_client import get_supabase_admin


log = structlog.get_logger(__name__)


#: Default operator-response window. The Hermes plugin sends its own
#: ``timeout_s`` per request; this is the fallback when the caller
#: forgets.
DEFAULT_TIMEOUT_S = 600

#: Poll interval while waiting for the operator decision. 250ms keeps
#: end-to-end wakeup under the ~500ms SLO without hammering Postgres.
POLL_INTERVAL_S = 0.25

#: Hard cap on simultaneous in-flight approvals. The 11th concurrent
#: request gets a 503 from the route layer (see :func:`acquire_slot`).
MAX_CONCURRENT = 10

#: Decision value returned when the operator times out / cancels. Stays
#: in sync with ``approval_decision_enum`` in migration 0008.
_REJECTED = "rejected"


# ---------------------------------------------------------------------------
# Result + error types
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ApprovalDecision:
    """The operator's decision (or a synthetic one on timeout/cancel)."""

    decision: str  # "approved" | "rejected" | "approved_with_caveat"
    notes: str | None = None


class ApprovalError(RuntimeError):
    """Raised when Supabase plumbing fails during request_approval.

    The route turns this into 502 so the plugin retries rather than
    proceeds with a false "rejected".
    """


# ---------------------------------------------------------------------------
# Concurrency cap
# ---------------------------------------------------------------------------


# Module-level semaphore + lock for accurate non-blocking acquisition.
# We don't use ``Semaphore.acquire(timeout=0)`` because that's not
# part of asyncio's public API — instead we expose a non-blocking
# ``locked()`` check via :class:`_SlotGuard` below.
_slot_lock = asyncio.Lock()
_active_count = 0


class _SlotGuard:
    """Async context manager that acquires/releases an approval slot.

    Use :func:`acquire_slot` to get one; calling code that already has
    a guard never has to check the cap again. If the cap is full,
    :func:`acquire_slot` returns ``None``.
    """

    async def __aenter__(self) -> "_SlotGuard":
        return self

    async def __aexit__(self, *_exc: Any) -> None:
        global _active_count
        async with _slot_lock:
            _active_count = max(0, _active_count - 1)


async def acquire_slot() -> _SlotGuard | None:
    """Try to grab a concurrency slot. Returns ``None`` when the cap is full.

    The cap is enforced at the route boundary so the plugin gets an
    immediate 503 — long-polling 11 simultaneous approvals on one host
    means something is wrong upstream (probably a runaway agent loop).
    """
    global _active_count
    async with _slot_lock:
        if _active_count >= MAX_CONCURRENT:
            return None
        _active_count += 1
    return _SlotGuard()


def _current_slot_count() -> int:
    """Test-only accessor for the live slot count."""
    return _active_count


def _reset_slots() -> None:
    """Test-only: clear the slot counter between tests."""
    global _active_count
    _active_count = 0


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _now_utc() -> datetime:
    """Indirection so tests can monkey-patch the clock."""
    return datetime.now(timezone.utc)


def _row_decision(row: dict[str, Any]) -> ApprovalDecision:
    """Build an :class:`ApprovalDecision` from a row dict.

    Falls back to ``rejected`` if ``decision`` is somehow null on a
    ``status='decided'`` row (shouldn't happen by schema invariants,
    but we never want to return ``None`` to the plugin).
    """
    decision = row.get("decision") or _REJECTED
    notes = row.get("decision_notes")
    return ApprovalDecision(decision=decision, notes=notes)


def _select_one(supabase: Any, approval_id: str) -> dict[str, Any] | None:
    """SELECT one ``approvals`` row by id. Returns ``None`` when missing."""
    result = (
        supabase.table("approvals")
        .select("*")
        .eq("id", approval_id)
        .execute()
    )
    rows = getattr(result, "data", None) or []
    if not rows:
        return None
    return rows[0]


def _upsert_pending(
    supabase: Any,
    *,
    approval_id: str,
    ekko_session_id: str,
    ekko_tool_call_id: str,
    tool_name: str,
    tool_args: dict[str, Any],
    risk_class: str | None,
    context: dict[str, Any] | None,
    timeout_s: int,
) -> None:
    """Insert a fresh ``pending`` approval row.

    The plugin guarantees ``approval_id`` is unique per tool call, so
    we use UPSERT keyed on ``id`` for idempotent retries. The row
    might already exist (status=pending) from a prior in-flight call;
    UPSERT-with-conflict-do-nothing is the natural shape, but the
    Supabase Python client exposes ``on_conflict`` for the same effect.
    """
    now = _now_utc()
    expires = now + timedelta(seconds=timeout_s)
    payload = {
        "id": approval_id,
        "ekko_session_id": ekko_session_id,
        "ekko_tool_call_id": ekko_tool_call_id,
        "tool_name": tool_name,
        "tool_args": tool_args,
        "risk_class": risk_class,
        "context": context or {},
        "requested_at": now.isoformat(),
        "expires_at": expires.isoformat(),
        "status": "pending",
        "worker_received_at": now.isoformat(),
    }
    (
        supabase.table("approvals")
        .upsert(payload, on_conflict="id")
        .execute()
    )


async def _notify_safely(row: dict[str, Any]) -> None:
    """Wrapper around :func:`approval_notifications.fan_out` that never raises.

    The long-poll schedules this via :func:`asyncio.create_task`; if it
    ever raised, asyncio would log "Task exception was never retrieved"
    and the operator would lose the notification with no visible signal.
    Catching here keeps the log narrative inside our structlog stream and
    means a future change to the fan-out helper can't accidentally break
    the long-poll.
    """
    try:
        # Lazy import — keeps the module importable in tests that don't
        # touch notifications, and avoids a circular import between this
        # module and ``approval_notifications`` (which in turn imports the
        # push-delivery service).
        from . import approval_notifications

        await approval_notifications.fan_out(row)
    except Exception as exc:  # noqa: BLE001 — best-effort fire-and-forget
        log.warning(
            "approval_notifications_failed",
            approval_id=row.get("id"),
            error=str(exc),
        )


def _mark_expired(supabase: Any, approval_id: str) -> None:
    """Flip ``pending`` → ``expired``. No-op when the row is decided/cancelled.

    The conditional update is what keeps a late operator decision from
    being clobbered: if the row already moved out of ``pending`` while
    we were preparing the expiry write, the update affects zero rows.
    """
    (
        supabase.table("approvals")
        .update({"status": "expired"})
        .eq("id", approval_id)
        .eq("status", "pending")
        .execute()
    )


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


async def request_approval(
    *,
    approval_id: str,
    ekko_session_id: str,
    ekko_tool_call_id: str,
    tool_name: str,
    tool_args: dict[str, Any],
    risk_class: str | None = None,
    context: dict[str, Any] | None = None,
    timeout_s: int = DEFAULT_TIMEOUT_S,
) -> ApprovalDecision:
    """Long-poll for the operator's decision on one tool call.

    The caller (route layer) is responsible for acquiring a slot via
    :func:`acquire_slot` BEFORE invoking this — that way the 503
    response can short-circuit without spinning up a poll loop.

    Args:
        approval_id: Plugin-side deterministic uuid for this tool call.
            The schema requires it; we never default it.
        ekko_session_id: Hermes/Ekko session that owns the tool call.
        ekko_tool_call_id: Tool-call id inside that session — used to
            build the deterministic ``approval_id`` and stored here so
            the dashboard can surface "what call is this?" context.
        tool_name: Display name of the tool the agent wants to run.
        tool_args: Full tool-args JSON for the operator UI to render.
        risk_class: ``"spend"`` / ``"network"`` / ``"fs"`` / ``"low"``
            or ``None`` if the plugin didn't tag it.
        context: Free-form additional context the dashboard renders.
        timeout_s: Seconds to wait for the operator before giving up.

    Returns:
        :class:`ApprovalDecision` with one of three decisions. Timeout
        and cancel both surface as ``rejected``; the ``notes`` field
        distinguishes them.

    Raises:
        :class:`ApprovalError` if the Supabase admin client is
        unavailable or any SELECT/UPSERT raises. The route translates
        that into 502.
    """
    try:
        supabase = get_supabase_admin()
    except Exception as exc:  # noqa: BLE001 — surface as ApprovalError
        log.warning("hermes_approval_no_supabase", error=str(exc))
        raise ApprovalError(f"Supabase client unavailable: {exc}") from exc

    # 1. Idempotency: if the row is already decided, return the existing
    # decision without touching anything else. The plugin will get its
    # answer in one round-trip even on retry.
    try:
        existing = _select_one(supabase, approval_id)
    except Exception as exc:  # noqa: BLE001
        log.warning(
            "hermes_approval_select_failed",
            approval_id=approval_id,
            error=str(exc),
        )
        raise ApprovalError(f"approvals select failed: {exc}") from exc

    if existing is not None:
        status_val = existing.get("status")
        if status_val == "decided":
            return _row_decision(existing)
        if status_val == "cancelled":
            return ApprovalDecision(
                decision=_REJECTED, notes="Approval was cancelled"
            )
        if status_val == "expired":
            return ApprovalDecision(
                decision=_REJECTED,
                notes="Operator did not respond within timeout",
            )
        # status == "pending" — fall through to subscription/poll. We
        # deliberately skip the UPSERT in this case so we don't reset
        # the original ``requested_at`` / ``expires_at``.

    if existing is None:
        try:
            _upsert_pending(
                supabase,
                approval_id=approval_id,
                ekko_session_id=ekko_session_id,
                ekko_tool_call_id=ekko_tool_call_id,
                tool_name=tool_name,
                tool_args=tool_args,
                risk_class=risk_class,
                context=context,
                timeout_s=timeout_s,
            )
        except Exception as exc:  # noqa: BLE001
            log.warning(
                "hermes_approval_upsert_failed",
                approval_id=approval_id,
                error=str(exc),
            )
            raise ApprovalError(f"approvals upsert failed: {exc}") from exc

        # HI-17: fire notifications fan-out as a background task. Only for
        # newly-inserted rows (skip on pending-resume retry, otherwise the
        # operator gets a duplicate push every time the plugin reconnects
        # to its long-poll). Fire-and-forget — the long-poll cannot wait on
        # push delivery / Resend without blowing past the 500ms SLO.
        new_row = {
            "id": approval_id,
            "ekko_session_id": ekko_session_id,
            "ekko_tool_call_id": ekko_tool_call_id,
            "tool_name": tool_name,
            "tool_args": tool_args,
            "risk_class": risk_class,
            "context": context or {},
        }
        asyncio.create_task(_notify_safely(new_row))

    log.info(
        "hermes_approval_waiting",
        approval_id=approval_id,
        ekko_session_id=ekko_session_id,
        tool_name=tool_name,
        timeout_s=timeout_s,
    )

    # 2. Poll until decided / cancelled / timeout. We use the event-loop
    # clock to compute the deadline so monkey-patching ``_now_utc``
    # doesn't accidentally affect the poll loop.
    loop = asyncio.get_event_loop()
    deadline = loop.time() + timeout_s
    while loop.time() < deadline:
        await asyncio.sleep(POLL_INTERVAL_S)
        try:
            row = _select_one(supabase, approval_id)
        except Exception as exc:  # noqa: BLE001
            log.warning(
                "hermes_approval_poll_failed",
                approval_id=approval_id,
                error=str(exc),
            )
            raise ApprovalError(f"approvals poll failed: {exc}") from exc
        if row is None:
            # The row vanished — treat as cancelled rather than spinning
            # forever. This is a deeply unexpected state but keeping the
            # plugin responsive matters more than diagnosing it here.
            log.warning(
                "hermes_approval_row_missing", approval_id=approval_id
            )
            return ApprovalDecision(
                decision=_REJECTED, notes="Approval record disappeared"
            )
        status_val = row.get("status")
        if status_val == "decided":
            return _row_decision(row)
        if status_val == "cancelled":
            return ApprovalDecision(
                decision=_REJECTED, notes="Approval was cancelled"
            )
        if status_val == "expired":
            return ApprovalDecision(
                decision=_REJECTED,
                notes="Operator did not respond within timeout",
            )

    # 3. Timeout. Flip pending → expired without clobbering a late
    # decision. We log but never raise on the expiry write failing.
    try:
        _mark_expired(supabase, approval_id)
    except Exception as exc:  # noqa: BLE001 — best-effort
        log.warning(
            "hermes_approval_expire_failed",
            approval_id=approval_id,
            error=str(exc),
        )

    log.info(
        "hermes_approval_timed_out",
        approval_id=approval_id,
        timeout_s=timeout_s,
    )
    return ApprovalDecision(
        decision=_REJECTED, notes="Operator did not respond within timeout"
    )


async def cancel_approval(approval_id: str) -> bool:
    """Flip a pending approval to ``cancelled``.

    Returns ``True`` when at least one pending row was transitioned,
    ``False`` otherwise (already decided / cancelled / non-existent).
    Plugin calls this when the originating session ends so the
    operator stops seeing stale prompts.
    """
    try:
        supabase = get_supabase_admin()
    except Exception as exc:  # noqa: BLE001
        log.warning("hermes_approval_cancel_no_supabase", error=str(exc))
        raise ApprovalError(f"Supabase client unavailable: {exc}") from exc

    try:
        result = (
            supabase.table("approvals")
            .update({"status": "cancelled"})
            .eq("id", approval_id)
            .eq("status", "pending")
            .execute()
        )
    except Exception as exc:  # noqa: BLE001
        log.warning(
            "hermes_approval_cancel_failed",
            approval_id=approval_id,
            error=str(exc),
        )
        raise ApprovalError(f"approvals cancel failed: {exc}") from exc

    rows = getattr(result, "data", None) or []
    return len(rows) > 0


async def get_approval(approval_id: str) -> dict[str, Any] | None:
    """Read one ``approvals`` row by id, returning ``None`` when missing.

    Powers the plugin's health-check route — used to recover after a
    network blip without re-opening a long-poll.
    """
    try:
        supabase = get_supabase_admin()
    except Exception as exc:  # noqa: BLE001
        log.warning("hermes_approval_get_no_supabase", error=str(exc))
        raise ApprovalError(f"Supabase client unavailable: {exc}") from exc

    try:
        return _select_one(supabase, approval_id)
    except Exception as exc:  # noqa: BLE001
        log.warning(
            "hermes_approval_get_failed",
            approval_id=approval_id,
            error=str(exc),
        )
        raise ApprovalError(f"approvals get failed: {exc}") from exc


def get_approval_token() -> str | None:
    """Return the shared bearer for ``/work/hermes/approval`` routes.

    SEPARATE from ``WORKER_SHARED_SECRET`` because the Hermes plugin
    lives in Ekko's container, not the dashboard — so it gets its own
    narrowly-scoped token (``VOXHORIZON_APPROVAL_TOKEN``). Comparison
    is constant-time at the route layer; here we just resolve the env
    value, returning ``None`` for missing / blank-after-strip.
    """
    import os

    raw = os.environ.get("VOXHORIZON_APPROVAL_TOKEN")
    if raw is None:
        return None
    stripped = raw.strip()
    return stripped or None


__all__ = [
    "ApprovalDecision",
    "ApprovalError",
    "DEFAULT_TIMEOUT_S",
    "MAX_CONCURRENT",
    "POLL_INTERVAL_S",
    "acquire_slot",
    "cancel_approval",
    "get_approval",
    "get_approval_token",
    "request_approval",
]


# Re-export the notification fire-and-forget wrapper so tests can patch it
# at the module boundary without poking private internals.
notify_safely = _notify_safely
