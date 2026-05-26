"""Pure observer for the unified work_item queue (silent-failure PR-1).

The decision half of the watchdog: takes the claimed/running ``work_item``
rows + the consumer presence rows + a clock, returns the rows the
scheduler-side wrapper must rotate (requeue with a parent_work_item_id) or
terminally fail (max attempts exceeded), and the consumers it must flag as
``degraded`` or ``down``. Does NO I/O -- so it is trivially unit-testable
and never re-dispatches on a transient Supabase blip.

The scheduler wrapper (``services.scheduler.run_work_item_watchdog_once``)
reads the open rows + consumers from Postgres, calls these pure functions,
and writes the rotations / requeues / consumer status flips.

Mirrors the style of :mod:`services.operator_dispatch_watchdog` (the legacy
per-domain watchdog this one will replace in PR-3): a frozen dataclass per
decision, deterministic sort, parsed timestamps via a shared helper, and
exhaustive coverage of malformed inputs (a row whose heartbeat is null or a
consumer whose last_seen_at is garbage NEVER triggers a state flip).
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Iterable


#: Default thresholds (the scheduler reads these from Settings; tests pin them
#: explicitly so the timing semantics are deterministic without an env block).
DEFAULT_HEARTBEAT_THRESHOLD = timedelta(seconds=120)
DEFAULT_MAX_ATTEMPTS = 3
DEFAULT_CONSUMER_HEARTBEAT = timedelta(seconds=30)


def _parse_ts(value: Any) -> datetime | None:
    """Parse a timestamptz string/datetime into tz-aware UTC.

    Mirrors :func:`services.operator_dispatch_watchdog._parse_ts`; supabase-py
    returns ISO strings (often with a trailing ``Z``), occasionally a real
    datetime. Returns None for missing/garbage so the caller can fall back to
    a safe default and the watchdog never acts on bad data.
    """
    if value is None:
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


# ----------------------------------------------------------------------------
# Stuck work-items
# ----------------------------------------------------------------------------


@dataclass(frozen=True)
class StuckWorkItem:
    """One work_item the scheduler must rotate or terminally fail.

    Carries exactly what the scheduler-side wrapper needs to make the call:
    the identity (id / kind / payload / pipeline scoping so a requeue can
    rebuild the new row), the current ``attempt`` (so the wrapper compares it
    to ``max_attempts`` to choose requeue vs. dead-letter), the previous
    ``claim_token`` (so the rotation is token-safe), and the staleness for
    structured logs.
    """

    work_item_id: str
    kind: str
    attempt: int
    claim_token: str | None
    payload: dict[str, Any]
    pipeline_id: str | None
    creative_id: str | None
    brief_id: str | None
    idle_seconds: float
    last_heartbeat: datetime | None


def _heartbeat_clock(row: dict[str, Any]) -> datetime | None:
    """The most recent sign of life for a claimed/running work_item.

    The heartbeat clock is ``heartbeat_at`` when present (running), else
    ``claimed_at`` (claimed but never heartbeated yet -- the consumer is
    inside its claim->running grace window). Either is the canonical
    "consumer last touched this" timestamp.
    """
    candidates = [
        _parse_ts(row.get("heartbeat_at")),
        _parse_ts(row.get("claimed_at")),
    ]
    present = [c for c in candidates if c is not None]
    return max(present) if present else None


def find_stuck_work_items(
    rows: Iterable[dict[str, Any]],
    *,
    threshold: timedelta = DEFAULT_HEARTBEAT_THRESHOLD,
    now: datetime | None = None,
) -> list[StuckWorkItem]:
    """Return the claimed/running rows whose heartbeat is ``>= threshold`` stale.

    A row is stuck iff:
      * ``status in {'claimed', 'running'}`` (the held set);
      * its heartbeat clock parses;
      * the clock is at least ``threshold`` in the past.

    Terminal rows, queued rows, rows whose timestamps are unparseable, and
    rows still inside the window are excluded. Results are sorted oldest-idle
    first so the scheduler rotates the most-stuck rows first.
    """
    current = now or datetime.now(timezone.utc)
    if current.tzinfo is None:
        current = current.replace(tzinfo=timezone.utc)

    stuck: list[StuckWorkItem] = []
    for row in rows:
        status = row.get("status")
        if status not in ("claimed", "running"):
            continue
        clock = _heartbeat_clock(row)
        if clock is None:
            # The CHECK invariants say a claimed row HAS claimed_at; an
            # unparseable timestamp is a defective row -- skip rather than
            # rotate on bad data (matches operator_dispatch_watchdog).
            continue
        idle = current - clock
        if idle < threshold:
            continue
        work_item_id = row.get("id")
        kind = row.get("kind")
        if not work_item_id or not kind:
            continue
        payload = row.get("payload")
        if not isinstance(payload, dict):
            payload = {}
        stuck.append(
            StuckWorkItem(
                work_item_id=str(work_item_id),
                kind=str(kind),
                attempt=int(row.get("attempt") or 0),
                claim_token=(
                    str(row["claim_token"]) if row.get("claim_token") else None
                ),
                payload=dict(payload),
                pipeline_id=(
                    str(row["pipeline_id"]) if row.get("pipeline_id") else None
                ),
                creative_id=(
                    str(row["creative_id"]) if row.get("creative_id") else None
                ),
                brief_id=(
                    str(row["brief_id"]) if row.get("brief_id") else None
                ),
                idle_seconds=idle.total_seconds(),
                last_heartbeat=clock,
            )
        )

    stuck.sort(key=lambda s: s.idle_seconds, reverse=True)
    return stuck


def compute_backoff_seconds(
    *,
    attempt: int,
    base_seconds: int = 60,
    cap_seconds: int = 3600,
) -> int:
    """Exponential backoff for a requeued attempt (capped).

    ``attempt`` is the attempt count BEFORE the rotation (so the freshly
    requeued row, which will become attempt+1, gets ``base * 2**attempt``
    seconds of delay). Capped at ``cap_seconds`` so a runaway retry chain
    can't push next_attempt_at into the year 3000.
    """
    if attempt < 0:
        attempt = 0
    # 60 * 2^0 = 60, 60 * 2^1 = 120, ..., capped.
    raw = base_seconds * (2 ** min(attempt, 20))
    return min(raw, cap_seconds)


# ----------------------------------------------------------------------------
# Stale consumers
# ----------------------------------------------------------------------------


@dataclass(frozen=True)
class StaleConsumer:
    """One consumer whose ``last_seen_at`` is stale enough to flip status.

    ``target_status`` is ``'degraded'`` (between 2x and 4x the heartbeat
    interval) or ``'down'`` (>= 4x). A consumer that is already in the target
    status is omitted -- the scheduler only writes transitions.
    """

    consumer_id: str
    kind: str
    current_status: str
    target_status: str
    last_seen_at: datetime
    idle_seconds: float


def find_stale_consumers(
    rows: Iterable[dict[str, Any]],
    *,
    heartbeat_interval: timedelta = DEFAULT_CONSUMER_HEARTBEAT,
    now: datetime | None = None,
) -> list[StaleConsumer]:
    """Return the consumers whose presence is stale.

    A consumer is:
      * ``degraded`` when ``last_seen_at`` is between 2x and 4x the heartbeat
        interval (the consumer is alive but slow / pre-down);
      * ``down`` when it is >= 4x stale (the daemon almost certainly died).

    A consumer already in the target status, or in a terminal manual status
    (``'stopped'``), is skipped -- the scheduler only writes transitions.
    """
    current = now or datetime.now(timezone.utc)
    if current.tzinfo is None:
        current = current.replace(tzinfo=timezone.utc)

    degraded_after = heartbeat_interval * 2
    down_after = heartbeat_interval * 4

    stale: list[StaleConsumer] = []
    for row in rows:
        consumer_id = row.get("id")
        if not consumer_id:
            continue
        last_seen = _parse_ts(row.get("last_seen_at"))
        if last_seen is None:
            continue
        idle = current - last_seen
        current_status = str(row.get("status") or "")
        # A 'stopped' consumer was cleanly shut down; do not flip it.
        if current_status == "stopped":
            continue
        target: str | None = None
        if idle >= down_after:
            target = "down"
        elif idle >= degraded_after:
            target = "degraded"
        if target is None or target == current_status:
            continue
        stale.append(
            StaleConsumer(
                consumer_id=str(consumer_id),
                kind=str(row.get("kind") or ""),
                current_status=current_status,
                target_status=target,
                last_seen_at=last_seen,
                idle_seconds=idle.total_seconds(),
            )
        )

    stale.sort(key=lambda s: s.idle_seconds, reverse=True)
    return stale


__all__ = [
    "DEFAULT_CONSUMER_HEARTBEAT",
    "DEFAULT_HEARTBEAT_THRESHOLD",
    "DEFAULT_MAX_ATTEMPTS",
    "StaleConsumer",
    "StuckWorkItem",
    "compute_backoff_seconds",
    "find_stale_consumers",
    "find_stuck_work_items",
]
