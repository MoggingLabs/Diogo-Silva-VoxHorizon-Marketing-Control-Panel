"""Work-item queue DB facade (silent-failure redesign PR-1).

Thin, pure functions over an INJECTED supabase-py client (so tests pass a
``FakeSupabase`` and the route layer / scheduler pass the real admin client).
Mirrors :mod:`services.atomic_inserts` in style: type hints, structured
logging, no surprise side effects.

The schema this faces is migration 0050 (``db/migrations/0050_work_item_queue.sql``).
Every CHECK constraint in that migration is a structural invariant a route or
consumer cannot trip silently:

* ``work_item_claim_consistent`` -- ``queued/terminal`` rows release the claim;
  ``claimed/running`` rows hold it. A facade that tried to flip status without
  rotating the claim would be rejected.
* ``work_item_running_heartbeated`` -- a ``running`` row MUST have at least one
  ``heartbeat_at``. :func:`heartbeat_work_item` is the only path that mints it.
* ``work_item_terminal_closed`` -- ``completed/failed/timed_out/cancelled``
  rows MUST carry ``completed_at`` and MUST NOT hold a claim. Every terminal
  helper in this module writes both.
* ``work_item_failure_explained`` -- ``failed/timed_out`` rows MUST name an
  ``error_kind``. :func:`fail_work_item` enforces this at the type level (the
  parameter is non-optional).

The claim_token rotation is the single-writer guard: heartbeat / complete /
fail / cancel are token-scoped UPDATEs that hit 0 rows when the watchdog has
already rotated the token (a consumer stalled too long, the watchdog requeued
its work). The boolean return distinguishes "I owned this transition" from
"my claim was already invalidated; abort cleanly".

Routes/scheduler-side I/O wraps these (see ``routes/work_queue.py`` +
``services/scheduler.py``); these are intentionally synchronous: supabase-py
is itself synchronous, and the FastAPI handlers call them under
``run_in_threadpool`` semantics, so making them ``async`` would add noise
without benefit.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

import structlog


log = structlog.get_logger(__name__)


# ----------------------------------------------------------------------------
# Constants the consumer / routes can import as one source of truth.
# ----------------------------------------------------------------------------

#: Statuses a row sits in before terminal close (every CHECK invariant maps
#: to this set). Mirrors the work_item_status enum in 0050.
OPEN_STATUSES: frozenset[str] = frozenset({"queued", "claimed", "running"})
TERMINAL_STATUSES: frozenset[str] = frozenset(
    {"completed", "failed", "timed_out", "cancelled"}
)
HELD_STATUSES: frozenset[str] = frozenset({"claimed", "running"})


def _now_iso() -> str:
    """ISO-8601 UTC timestamp string supabase-py accepts as ``timestamptz``."""
    return datetime.now(timezone.utc).isoformat()


# ----------------------------------------------------------------------------
# Enqueue (idempotent on idempotency_key)
# ----------------------------------------------------------------------------


def enqueue_work_item(
    sb: Any,
    *,
    kind: str,
    payload: dict[str, Any],
    idempotency_key: str,
    created_by: str,
    pipeline_id: str | None = None,
    creative_id: str | None = None,
    brief_id: str | None = None,
    parent_work_item_id: str | None = None,
    next_attempt_at: str | None = None,
) -> dict[str, Any]:
    """Insert one ``work_item`` row in ``status='queued'`` (idempotent on key).

    A second enqueue with the SAME ``idempotency_key`` returns the existing row
    without inserting (the UNIQUE constraint catches it). This is how routes
    safely retry a fire-and-forget without double-dispatching.

    The ``work_item_emit_pipeline_event`` trigger auto-emits one
    ``pipeline_events`` row for the queued transition when ``pipeline_id`` is
    set, so callers must NOT also insert one (would double-log + violate the
    "no second write to forget" invariant the redesign closes).

    Args:
      sb: supabase-py service-role client (real or test double).
      kind: ``work_item_kind`` enum value (e.g. ``'operator_dispatch'``).
      payload: per-shape request envelope (validated by the consumer, NOT here).
      idempotency_key: stable dedup key (see migration 0050 per-kind conventions).
      created_by: provenance string (route or worker module that enqueued).
      pipeline_id / creative_id / brief_id: optional scoping FKs.
      parent_work_item_id: set on watchdog retries (chains the retry trail).
      next_attempt_at: optional ISO timestamp for delayed eligibility (backoff);
        defaults to the DB ``now()``.

    Returns the inserted (or pre-existing) row as a dict.

    Raises whatever supabase-py raises on a non-conflict error so the caller's
    HTTP handler can return 5xx instead of silently dropping the work.
    """
    # Probe for an existing row first: an idempotent retry is a SELECT not an
    # INSERT, so we don't churn the audit trail on every duplicate kick. The
    # UNIQUE backs us up on the race window between probe and insert.
    existing = (
        sb.table("work_item")
        .select("*")
        .eq("idempotency_key", idempotency_key)
        .maybe_single()
        .execute()
    )
    if existing is not None and isinstance(existing.data, dict):
        log.info(
            "work_item_enqueue_dedup",
            idempotency_key=idempotency_key,
            kind=kind,
            existing_id=existing.data.get("id"),
        )
        return dict(existing.data)

    row: dict[str, Any] = {
        "kind": kind,
        "status": "queued",
        "payload": payload,
        "idempotency_key": idempotency_key,
        "created_by": created_by,
    }
    if pipeline_id is not None:
        row["pipeline_id"] = pipeline_id
    if creative_id is not None:
        row["creative_id"] = creative_id
    if brief_id is not None:
        row["brief_id"] = brief_id
    if parent_work_item_id is not None:
        row["parent_work_item_id"] = parent_work_item_id
    if next_attempt_at is not None:
        row["next_attempt_at"] = next_attempt_at

    try:
        resp = sb.table("work_item").insert(row).execute()
    except Exception as exc:  # noqa: BLE001 -- a unique-key race == already enqueued
        # On a duplicate-key race that beat the probe, re-read and return the
        # winner. Other DB errors propagate (the route should 5xx).
        msg = str(exc).lower()
        if "idempotency_key" in msg or "unique" in msg or "duplicate" in msg:
            log.info(
                "work_item_enqueue_race_dedup",
                idempotency_key=idempotency_key,
                kind=kind,
                error=str(exc),
            )
            again = (
                sb.table("work_item")
                .select("*")
                .eq("idempotency_key", idempotency_key)
                .maybe_single()
                .execute()
            )
            if again is not None and isinstance(again.data, dict):
                return dict(again.data)
        raise

    inserted: dict[str, Any] = {}
    if resp is not None and isinstance(resp.data, list) and resp.data:
        inserted = dict(resp.data[0])
    log.info(
        "work_item_enqueued",
        idempotency_key=idempotency_key,
        kind=kind,
        pipeline_id=pipeline_id,
        work_item_id=inserted.get("id"),
    )
    return inserted


# ----------------------------------------------------------------------------
# Claim (atomic RPC wrapper)
# ----------------------------------------------------------------------------


def claim_work_item(
    sb: Any,
    *,
    kind: str,
    consumer: str,
) -> dict[str, Any] | None:
    """Atomically claim the oldest-due ``work_item`` of ``kind`` for a consumer.

    Wraps the ``claim_work_item(kind, consumer)`` RPC defined in migration 0050,
    which is ``FOR UPDATE SKIP LOCKED`` so N consumers never collide. Returns
    the row (with a freshly minted ``claim_token``) or ``None`` when nothing is
    due. The consumer keeps the token in memory and presents it on every
    subsequent heartbeat / complete / fail call.
    """
    resp = sb.rpc(
        "claim_work_item", {"p_kind": kind, "p_consumer": consumer}
    ).execute()
    data = getattr(resp, "data", None)
    # PG RPCs that return a row may surface as a list of one (PostgREST), a
    # dict, or None when no row was claimed.
    if data is None:
        return None
    if isinstance(data, list):
        if not data:
            return None
        row = data[0]
        return dict(row) if isinstance(row, dict) and row else None
    if isinstance(data, dict):
        if not data:
            return None
        # PG returns the empty work_item record (all-null columns) for "nothing
        # due"; treat a row with no id as "nothing claimed".
        if not data.get("id"):
            return None
        return dict(data)
    return None


# ----------------------------------------------------------------------------
# Heartbeat / complete / fail / cancel -- all token-scoped UPDATEs.
# ----------------------------------------------------------------------------


def _token_scoped_rows(resp: Any) -> int:
    """Return rows-updated count from a supabase-py response (best-effort)."""
    data = getattr(resp, "data", None)
    if isinstance(data, list):
        return len(data)
    if isinstance(data, dict):
        return 1 if data.get("id") else 0
    return 0


def heartbeat_work_item(
    sb: Any,
    *,
    work_item_id: str,
    claim_token: str,
) -> bool:
    """Refresh ``heartbeat_at`` for a held row; flip ``claimed -> running``.

    First call after :func:`claim_work_item` transitions ``claimed -> running``
    (the ``work_item_running_heartbeated`` CHECK requires a heartbeat before a
    row is ``running``); subsequent calls only bump ``heartbeat_at``. Both
    paths are token-scoped: an UPDATE with a stale ``claim_token`` returns 0
    rows -- the consumer's clock got rotated by the watchdog and it must
    abort. Returns True when our claim is still live.
    """
    now = _now_iso()
    resp = (
        sb.table("work_item")
        .update({"status": "running", "heartbeat_at": now})
        .eq("id", work_item_id)
        .eq("claim_token", claim_token)
        .in_("status", ["claimed", "running"])
        .execute()
    )
    rows = _token_scoped_rows(resp)
    if rows == 0:
        log.warning(
            "work_item_heartbeat_token_rotated",
            work_item_id=work_item_id,
        )
    return rows > 0


def complete_work_item(
    sb: Any,
    *,
    work_item_id: str,
    claim_token: str,
    result: dict[str, Any] | None,
) -> bool:
    """Close a held row as ``completed`` (token-scoped); clears the claim.

    The terminal write the consumer makes on success. Satisfies
    ``work_item_terminal_closed`` (sets ``completed_at`` + nulls the claim) in
    one atomic UPDATE. The auto-emit trigger fires one
    ``operator_completed`` / ``task_done`` event so the dashboard timeline
    advances without the route writing pipeline_events itself.
    """
    now = _now_iso()
    patch: dict[str, Any] = {
        "status": "completed",
        "completed_at": now,
        "claim_token": None,
        "claimed_by": None,
        "claimed_at": None,
    }
    if result is not None:
        patch["result"] = result
    resp = (
        sb.table("work_item")
        .update(patch)
        .eq("id", work_item_id)
        .eq("claim_token", claim_token)
        .execute()
    )
    rows = _token_scoped_rows(resp)
    if rows == 0:
        log.warning(
            "work_item_complete_token_rotated",
            work_item_id=work_item_id,
        )
    return rows > 0


def fail_work_item(
    sb: Any,
    *,
    work_item_id: str,
    claim_token: str,
    error_kind: str,
    error_detail: dict[str, Any] | None = None,
    retryable: bool = True,
    backoff_seconds: int = 60,
) -> bool:
    """Close a held row as ``failed`` (token-scoped); names what broke.

    ``error_kind`` is mandatory: the ``work_item_failure_explained`` CHECK
    rejects a failure that doesn't name itself, so failures cannot show up
    blank in the dashboard. ``retryable`` + ``backoff_seconds`` are PASSED
    THROUGH as metadata only -- this layer does NOT requeue. The
    ``run_work_item_watchdog_once`` observer in scheduler.py is the single
    place that decides whether to requeue a parent-chained row vs. dead-letter
    on max attempts; keeping requeue in one place is how the redesign
    guarantees retries can never go untracked.
    """
    now = _now_iso()
    detail = dict(error_detail) if error_detail else {}
    detail.setdefault("retryable", retryable)
    detail.setdefault("backoff_seconds", backoff_seconds)
    patch: dict[str, Any] = {
        "status": "failed",
        "completed_at": now,
        "error_kind": error_kind,
        "error_detail": detail,
        "claim_token": None,
        "claimed_by": None,
        "claimed_at": None,
    }
    resp = (
        sb.table("work_item")
        .update(patch)
        .eq("id", work_item_id)
        .eq("claim_token", claim_token)
        .execute()
    )
    rows = _token_scoped_rows(resp)
    if rows == 0:
        log.warning(
            "work_item_fail_token_rotated",
            work_item_id=work_item_id,
            error_kind=error_kind,
        )
    return rows > 0


def cancel_work_item(
    sb: Any,
    *,
    work_item_id: str,
    reason: str = "user_cancelled",
    claim_token: str | None = None,
) -> bool:
    """Close a row as ``cancelled``; clears the claim.

    Two callers shape:

    * The consumer (``claim_token`` supplied) on clean SIGTERM -- the cancel
      is token-scoped, an UPDATE that hits 0 rows means the watchdog already
      rotated the token and the consumer aborts cleanly.
    * The admin path (``claim_token=None``) -- the cancel route force-closes
      regardless of token; the ``pipeline_cancel_propagate_to_work_items``
      trigger does the same on a pipeline-wide cancel event so an in-flight
      operator never keeps writing after the pipeline is cancelled.

    ``reason`` lands in ``error_kind`` (kept stable and greppable -- the
    dashboard surfaces it directly).
    """
    now = _now_iso()
    patch: dict[str, Any] = {
        "status": "cancelled",
        "completed_at": now,
        "error_kind": reason,
        "claim_token": None,
        "claimed_by": None,
        "claimed_at": None,
    }
    query = sb.table("work_item").update(patch).eq("id", work_item_id)
    if claim_token is not None:
        query = query.eq("claim_token", claim_token)
    resp = query.execute()
    rows = _token_scoped_rows(resp)
    if rows == 0:
        log.warning(
            "work_item_cancel_no_rows",
            work_item_id=work_item_id,
            token_scoped=claim_token is not None,
        )
    return rows > 0


# ----------------------------------------------------------------------------
# Consumer presence (work_item_consumers)
# ----------------------------------------------------------------------------


def upsert_consumer(
    sb: Any,
    *,
    consumer_id: str,
    kind: str,
    status: str,
    startup_check: dict[str, Any] | None = None,
    image_tag: str | None = None,
    hostname: str | None = None,
) -> dict[str, Any]:
    """UPSERT a row in ``work_item_consumers`` keyed by ``id``.

    The daemon writes one row on startup (``status='starting'``), flips to
    ``'live'`` after the self-test, then heartbeats ``last_seen_at`` via
    :func:`heartbeat_consumer`. The ``DaemonHealthBadge`` reads this row to
    render live / starting / stale / down.
    """
    row: dict[str, Any] = {
        "id": consumer_id,
        "kind": kind,
        "status": status,
        "last_seen_at": _now_iso(),
    }
    if startup_check is not None:
        row["startup_check"] = startup_check
    if image_tag is not None:
        row["image_tag"] = image_tag
    if hostname is not None:
        row["hostname"] = hostname

    # Probe-then-write: supabase-py exposes no portable ``on_conflict``; the
    # primary-key probe is correct and identical in semantics for our scale.
    existing = (
        sb.table("work_item_consumers")
        .select("id")
        .eq("id", consumer_id)
        .maybe_single()
        .execute()
    )
    if existing is not None and isinstance(existing.data, dict):
        resp = (
            sb.table("work_item_consumers")
            .update(row)
            .eq("id", consumer_id)
            .execute()
        )
    else:
        resp = sb.table("work_item_consumers").insert(row).execute()

    data = getattr(resp, "data", None)
    if isinstance(data, list) and data:
        return dict(data[0])
    if isinstance(data, dict):
        return dict(data)
    return row


def heartbeat_consumer(sb: Any, *, consumer_id: str) -> None:
    """Bump ``last_seen_at`` for a consumer row (the staleness clock)."""
    sb.table("work_item_consumers").update(
        {"last_seen_at": _now_iso()}
    ).eq("id", consumer_id).execute()


__all__ = [
    "HELD_STATUSES",
    "OPEN_STATUSES",
    "TERMINAL_STATUSES",
    "cancel_work_item",
    "claim_work_item",
    "complete_work_item",
    "enqueue_work_item",
    "fail_work_item",
    "heartbeat_consumer",
    "heartbeat_work_item",
    "upsert_consumer",
]
