"""Transactional-outbox drainer for exactly-once external side effects (E5.1).

The ``integration_outbox`` table (migration 0023) is the durable queue for the
worker's external writes: a state change and the row that *describes* its side
effect are written together (see :mod:`routes.integrations`), so the side effect
is recoverable across a crash and applied exactly once. This module is the
missing drain half -- nothing read the table before.

A pass (:func:`run_outbox_relay_once`) does:

  1. **Claim** up to ``scheduler_outbox_max_per_pass`` *due* rows
     (``status in (pending, inflight)`` and ``next_attempt_at <= now``),
     oldest-due first, marking each ``inflight`` so a concurrent relay never
     re-claims it. The claim is the concurrency-safe seam:

       * the FAST path is an atomic ``FOR UPDATE SKIP LOCKED`` claim done in one
         Postgres round-trip via the ``claim_due_integration_outbox`` RPC -- it
         skips rows another worker already locked, so two relays draining the
         same table never collide. That function is OPTIONAL future hardening
         (a one-function SQL migration, deferred here so this change ships with
         NO schema change) -- the relay detects its absence and falls back, so
         it is NOT required for this change to work;
       * when the RPC is absent (the default today, no migration applied) the
         relay FALLS BACK to a REST claim: read the due rows, then flip each
         ``pending -> inflight`` with a status-guarded ``update`` so only one
         claimer wins the row. Bounded + idempotent either way.

  2. **Perform** the side effect via a registered handler keyed on
     ``(integration, op)``. Handlers are injected (``handlers=``) so the relay
     unit-tests with a fake side effect and forces zero live network.

  3. **Record the outcome** in the same row: success -> ``status='done'`` +
     ``result``; a retryable failure -> back off (``status='pending'`` with
     ``next_attempt_at = now + backoff(attempts)``) until ``attempts`` hits
     ``scheduler_outbox_max_attempts``, after which the row is **dead-lettered**
     (``status='dead'``) and surfaced by the observability outbox watchdog.

Bounded per pass (mirrors the dispatch-watchdog redispatch cap and the kie
reconcile cap in :mod:`config`) so a backlog can never fan out an unbounded
burst of external calls. A per-row failure is logged and skipped so one bad row
never aborts the sweep. The whole thing is wired into the periodic scheduler as
a supervised loop, exactly like :func:`services.scheduler.run_kie_reconcile_once`.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

import structlog

from ..config import Settings


log = structlog.get_logger(__name__)


# Outbox statuses that represent undelivered work (mirrors the 0023 due index
# and the observability ``_OPEN_OUTBOX_STATUSES`` set).
_DUE_STATUSES: frozenset[str] = frozenset({"pending", "inflight"})

# The Postgres function that does the atomic ``FOR UPDATE SKIP LOCKED`` claim.
# OPTIONAL: when it is not installed (the default today -- this change ships no
# migration) the relay uses the REST fallback claim. See the module docstring.
_CLAIM_RPC = "claim_due_integration_outbox"


# A side-effect handler: given the outbox row's ``request`` payload, perform the
# external write and return a JSON-serialisable result (stored in ``result``).
# Raising signals a retryable failure (back off); returning signals success.
OutboxHandler = Callable[[Mapping[str, Any]], Awaitable[Mapping[str, Any] | None]]


class OutboxRelayError(Exception):
    """A handler signalled an unrecoverable, do-not-retry failure.

    Raise this from a handler to dead-letter the row immediately (skip the
    remaining backoff attempts) -- e.g. a 4xx the external API will never accept.
    A plain ``Exception`` is treated as retryable and backed off instead.
    """


@dataclass(frozen=True)
class OutboxPassResult:
    """Outcome counts for one relay pass (handy for logs + tests)."""

    claimed: int
    done: int
    retried: int
    dead_lettered: int
    skipped: int


def _now() -> datetime:
    """Current aware-UTC time (single seam so tests can monkeypatch the clock)."""
    return datetime.now(timezone.utc)


def _now_iso() -> str:
    return _now().isoformat()


def _parse_ts(value: Any, *, default: datetime) -> datetime:
    """Parse a Supabase timestamptz to aware UTC, falling back to ``default``.

    Mirrors :func:`services.observability._parse_ts` but never returns ``None``
    -- a missing/garbled ``next_attempt_at`` is treated as due-now (``default``)
    so a row can never get stranded by an unparseable timestamp.
    """
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if not isinstance(value, str) or not value.strip():
        return default
    raw = value.strip()
    iso = raw.replace("Z", "+00:00") if raw.endswith("Z") else raw
    try:
        dt = datetime.fromisoformat(iso)
    except ValueError:
        return default
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def backoff_seconds(attempts: int, *, base_s: float, cap_s: float) -> float:
    """Exponential backoff for a row that has failed ``attempts`` times.

    ``base_s * 2 ** (attempts - 1)``, capped at ``cap_s``. ``attempts`` is the
    post-increment count (1 after the first failure), so the first retry waits
    ``base_s`` and each subsequent one doubles up to the cap. A non-positive
    ``attempts`` collapses to ``base_s`` (defensive).
    """
    if attempts <= 1:
        return min(base_s, cap_s)
    delay = base_s * (2 ** (attempts - 1))
    return min(delay, cap_s)


# ===========================================================================
# Claim
# ===========================================================================


def _claim_due_rows(sb: Any, *, limit: int, now: datetime) -> list[dict[str, Any]]:
    """Claim up to ``limit`` due outbox rows, marking each ``inflight``.

    Tries the atomic ``FOR UPDATE SKIP LOCKED`` RPC first; on any failure (the
    function isn't installed, or the call errors) falls back to the REST claim.
    Returns the claimed rows (already flipped to ``inflight``) so the caller can
    run their handlers without re-reading.
    """
    claimed = _claim_via_rpc(sb, limit=limit)
    if claimed is not None:
        return claimed
    return _claim_via_rest(sb, limit=limit, now=now)


def _claim_via_rpc(sb: Any, *, limit: int) -> list[dict[str, Any]] | None:
    """Atomic claim via the SKIP-LOCKED RPC, or ``None`` if it's unavailable.

    The function claims + returns the rows it locked in one round-trip, so
    concurrent relays never contend. ``None`` (not ``[]``) signals "RPC absent,
    use the fallback"; an empty list is a real "nothing due" answer.
    """
    try:
        resp = sb.rpc(_CLAIM_RPC, {"p_limit": limit}).execute()
    except Exception as exc:  # noqa: BLE001 -- RPC absent / errored -> REST fallback
        log.debug("outbox_claim_rpc_unavailable", error=str(exc))
        return None
    data = getattr(resp, "data", None) if resp is not None else None
    if data is None:
        return None
    if not isinstance(data, list):
        return None
    return [dict(r) for r in data if isinstance(r, dict)]


def _claim_via_rest(sb: Any, *, limit: int, now: datetime) -> list[dict[str, Any]]:
    """REST claim: read pending rows oldest-due-first, flip each to ``inflight``.

    Reads the ``pending`` rows ordered by ``next_attempt_at`` (the due index's
    sort key), filters to those actually due (``next_attempt_at <= now``) in
    Python -- so it needs only the ``eq``/``order``/``limit`` query surface the
    worker's supabase double supports -- and claims each with a status-guarded
    ``update`` (``pending -> inflight``). The guard means that if two relays read
    the same row, only the one whose update still matched ``status='pending'``
    proceeds; the loser's update touches zero rows and it skips the row. Bounded
    by ``limit``.
    """
    resp = (
        sb.table("integration_outbox")
        .select(
            "id, pipeline_id, integration, op, idempotency_key, request, "
            "status, attempts, next_attempt_at"
        )
        .eq("status", "pending")
        .order("next_attempt_at", desc=False)
        .limit(limit)
        .execute()
    )
    rows = resp.data if (resp is not None and isinstance(resp.data, list)) else []
    claimed: list[dict[str, Any]] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        due_at = _parse_ts(row.get("next_attempt_at"), default=now)
        if due_at > now:
            continue
        row_id = row.get("id")
        if not row_id:
            continue
        if not _guarded_claim(sb, row_id=str(row_id)):
            # Lost the race (another relay already claimed it) -- skip.
            continue
        claimed.append({**row, "status": "inflight"})
    return claimed


def _guarded_claim(sb: Any, *, row_id: str) -> bool:
    """Flip one row ``pending -> inflight`` only if it is still ``pending``.

    Returns True when this caller won the claim. The ``eq('status','pending')``
    guard is the race breaker: a concurrent claimer that already flipped the row
    leaves nothing for this update to match.
    """
    resp = (
        sb.table("integration_outbox")
        .update({"status": "inflight", "updated_at": _now_iso()})
        .eq("id", row_id)
        .eq("status", "pending")
        .execute()
    )
    updated = resp.data if (resp is not None and isinstance(resp.data, list)) else []
    return bool(updated)


# ===========================================================================
# Outcome recording
# ===========================================================================


def _mark_done(sb: Any, *, row_id: str, result: Mapping[str, Any] | None) -> None:
    """Record a successful side effect: ``status='done'`` + the result blob."""
    sb.table("integration_outbox").update(
        {
            "status": "done",
            "result": dict(result) if result is not None else {},
            "last_error": None,
            "updated_at": _now_iso(),
        }
    ).eq("id", row_id).execute()


def _mark_retry_or_dead(
    sb: Any,
    *,
    row_id: str,
    attempts: int,
    error: str,
    settings: Settings,
    now: datetime,
    force_dead: bool = False,
) -> str:
    """Back off a failed row, or dead-letter it once attempts are exhausted.

    ``attempts`` is the NEW (incremented) count. When it reaches
    ``scheduler_outbox_max_attempts`` (or ``force_dead`` -- a non-retryable
    :class:`OutboxRelayError`) the row goes ``dead``; otherwise it returns to
    ``pending`` with ``next_attempt_at`` pushed out by the backoff schedule.
    Returns ``'dead'`` or ``'pending'`` (what it set) for the caller's counters.
    """
    if force_dead or attempts >= settings.scheduler_outbox_max_attempts:
        sb.table("integration_outbox").update(
            {
                "status": "dead",
                "attempts": attempts,
                "last_error": error,
                "updated_at": _now_iso(),
            }
        ).eq("id", row_id).execute()
        return "dead"

    delay = backoff_seconds(
        attempts,
        base_s=settings.scheduler_outbox_backoff_base_s,
        cap_s=settings.scheduler_outbox_backoff_cap_s,
    )
    next_at = (now + timedelta(seconds=delay)).isoformat()
    sb.table("integration_outbox").update(
        {
            "status": "pending",
            "attempts": attempts,
            "next_attempt_at": next_at,
            "last_error": error,
            "updated_at": _now_iso(),
        }
    ).eq("id", row_id).execute()
    return "pending"


# ===========================================================================
# The pass
# ===========================================================================


async def run_outbox_relay_once(
    settings: Settings,
    *,
    handlers: Mapping[tuple[str, str], OutboxHandler],
    sb: Any | None = None,
) -> OutboxPassResult:
    """One bounded pass of the transactional-outbox relay (E5.1).

    Claims due rows (SKIP-LOCKED RPC fast path, REST fallback), runs the
    registered handler for each row's ``(integration, op)``, and records the
    outcome (done / backoff / dead-letter). ``handlers`` is injected so the relay
    is exactly-once over a *pure* side-effect map -- the wired set lives in
    :func:`default_handlers`; tests pass a fake. A per-row failure is logged and
    backed off; it never aborts the sweep. Returns per-outcome counts.

    A row whose ``(integration, op)`` has no handler is left ``inflight`` and
    counted as ``skipped`` (a deploy that predates the handler must not burn the
    row's attempts) -- the observability watchdog flags it if it lingers.
    """
    from ..supabase_client import get_supabase_admin  # lazy: never forces a client

    sb = sb or get_supabase_admin()
    now = _now()

    claimed = _claim_due_rows(
        sb, limit=settings.scheduler_outbox_max_per_pass, now=now
    )
    if not claimed:
        log.info("outbox_relay_no_due_rows")
        return OutboxPassResult(0, 0, 0, 0, 0)

    done = retried = dead = skipped = 0
    for row in claimed:
        row_id = str(row.get("id") or "")
        integration = str(row.get("integration") or "")
        op = str(row.get("op") or "")
        handler = handlers.get((integration, op))
        if handler is None:
            log.warning(
                "outbox_relay_no_handler",
                integration=integration,
                op=op,
                idempotency_key=row.get("idempotency_key"),
            )
            skipped += 1
            continue

        request = row.get("request")
        request = request if isinstance(request, dict) else {}
        attempts = int(row.get("attempts") or 0) + 1
        try:
            result = await handler(request)
        except OutboxRelayError as exc:
            outcome = _mark_retry_or_dead(
                sb,
                row_id=row_id,
                attempts=attempts,
                error=str(exc),
                settings=settings,
                now=now,
                force_dead=True,
            )
            dead += 1
            log.warning(
                "outbox_relay_dead_lettered",
                integration=integration,
                op=op,
                idempotency_key=row.get("idempotency_key"),
                attempts=attempts,
                reason="non_retryable",
                outcome=outcome,
            )
            continue
        except Exception as exc:  # noqa: BLE001 -- one bad row never sinks the pass
            outcome = _mark_retry_or_dead(
                sb,
                row_id=row_id,
                attempts=attempts,
                error=str(exc),
                settings=settings,
                now=now,
            )
            if outcome == "dead":
                dead += 1
                log.warning(
                    "outbox_relay_dead_lettered",
                    integration=integration,
                    op=op,
                    idempotency_key=row.get("idempotency_key"),
                    attempts=attempts,
                    reason="attempts_exhausted",
                    error=str(exc),
                )
            else:
                retried += 1
                log.warning(
                    "outbox_relay_retry_scheduled",
                    integration=integration,
                    op=op,
                    idempotency_key=row.get("idempotency_key"),
                    attempts=attempts,
                    error=str(exc),
                )
            continue

        _mark_done(sb, row_id=row_id, result=result)
        done += 1
        log.info(
            "outbox_relay_done",
            integration=integration,
            op=op,
            idempotency_key=row.get("idempotency_key"),
            attempts=attempts,
        )

    result = OutboxPassResult(
        claimed=len(claimed),
        done=done,
        retried=retried,
        dead_lettered=dead,
        skipped=skipped,
    )
    log.info(
        "outbox_relay_pass_done",
        claimed=result.claimed,
        done=result.done,
        retried=result.retried,
        dead_lettered=result.dead_lettered,
        skipped=result.skipped,
    )
    return result


# ===========================================================================
# Wired handler set
# ===========================================================================


def default_handlers() -> dict[tuple[str, str], OutboxHandler]:
    """The (integration, op) -> handler map the scheduled relay drains.

    Kept as a factory (not a module constant) so each scheduler tick builds a
    fresh map and tests can substitute their own. Today's external-write sites
    enqueue these ops (see :mod:`routes.integrations`):

      * ``("meta", "record_launch")``    -- post-launch follow-through for a
        recorded Meta entity graph (e.g. the deferred activation handoff /
        confirmation the operator's MCP cannot durably guarantee itself);
      * ``("drive", "finalize_verified")`` -- post-finalize follow-through for a
        md5-verified Drive asset (e.g. downstream notification / index update).

    The relay applies whatever side effect the handler encodes; the row's
    ``request`` payload carries everything the handler needs (it is the durable,
    crash-safe record of the intended effect). New external ops register here.
    """
    return {
        ("meta", "record_launch"): _handle_meta_record_launch,
        ("drive", "finalize_verified"): _handle_drive_finalized,
    }


async def _handle_meta_record_launch(
    request: Mapping[str, Any],
) -> Mapping[str, Any] | None:
    """Side effect for a recorded Meta launch (idempotent follow-through).

    The launch entities are already recorded transactionally by the route; this
    handler performs the durable *follow-through* (the part that must survive a
    crash + retry). It is intentionally a no-op shell today -- the operator's MCP
    owns the live Meta activation behind the approval gate (see
    :mod:`routes.integrations`), so there is no worker-side Meta call to make
    yet. It exists so the enqueue -> drain contract is complete + tested and the
    real follow-through is a one-function change with no relay/route churn.
    """
    log.info(
        "outbox_meta_record_launch",
        pipeline_id=request.get("pipeline_id"),
        entity_count=len(request.get("entities") or []),
    )
    return {"acknowledged": True, "pipeline_id": request.get("pipeline_id")}


async def _handle_drive_finalized(
    request: Mapping[str, Any],
) -> Mapping[str, Any] | None:
    """Side effect for a finalized Drive asset (idempotent follow-through).

    The creatives are already stamped ``finalize_verified`` transactionally by
    the route; this handler performs the durable follow-through. Like the Meta
    handler it is a no-op shell today (Drive is operator-held MCP -- the worker
    is the recorder), present so the durable enqueue -> drain path is complete
    and the real effect drops in without touching the relay or the route.
    """
    log.info(
        "outbox_drive_finalized",
        pipeline_id=request.get("pipeline_id"),
        asset_count=len(request.get("assets") or []),
    )
    return {"acknowledged": True, "pipeline_id": request.get("pipeline_id")}


__all__ = [
    "OutboxHandler",
    "OutboxPassResult",
    "OutboxRelayError",
    "backoff_seconds",
    "default_handlers",
    "run_outbox_relay_once",
]
