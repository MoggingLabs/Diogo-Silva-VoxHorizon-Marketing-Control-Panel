"""Stuck-dispatch watchdog (pure function).

Today the operator dispatch is blind fire-and-forget: the dashboard kicks
``hermes chat`` and never learns whether the operator ran, hung, or died. P3
adds the ``operator_dispatches`` ledger (one row per kick, heartbeated via
``/work/pipeline/tools/signal``) so a stuck dispatch becomes observable.

This module is the DECISION half: a pure function that, given the open dispatch
rows + a timeout + the current time, returns the set of dispatches to
re-dispatch. It does NO IO — no Supabase, no Docker, no clock read of its own —
so it is trivially unit-testable and deterministic. The CRON WIRING (read the
open rows, call this, re-dispatch each, mark ``timed_out``) is a later step;
see :data:`WATCHDOG_WIRING_NOTE`.

"Stuck" definition (mirrors the table's status semantics in 0023):

  * A dispatch is OPEN while ``status in {'dispatched', 'running'}`` — a
    terminal row (``completed``/``failed``/``timed_out``) is never re-dispatched.
  * Its liveness clock is the most recent of ``last_heartbeat_at`` (a ``running``
    heartbeat) and ``dispatched_at`` (the kick). A ``dispatched`` row that never
    sent a heartbeat is judged from when it was kicked.
  * It is STUCK when ``now - liveness_clock >= timeout``.

A re-dispatched stuck row resumes by skip-done: the operator's per-creative
stages skip already-``passed|overridden|skipped`` creatives, and the
deterministic render skips already-rendered concepts, so re-running is safe and
idempotent (no duplicate work, no double spend).
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Iterable


#: Default stuck threshold. An open dispatch silent for this long is re-dispatched.
DEFAULT_TIMEOUT = timedelta(minutes=15)

#: The dispatch statuses that are still "open" (eligible to be judged stuck).
OPEN_STATUSES = frozenset({"dispatched", "running"})

#: Reminder for the (later) cron wiring — kept in code so the follow-up issue
#: that schedules this can grep for it.
WATCHDOG_WIRING_NOTE = (
    "CRON WIRING (later step, see #354): a periodic job reads the open "
    "operator_dispatches rows, calls find_stuck_dispatches(rows, timeout, now), "
    "marks each returned row 'timed_out', and re-dispatches the operator for "
    "(pipeline_id, stage, expected_status). Resume is idempotent (skip-done)."
)


@dataclass(frozen=True)
class StuckDispatch:
    """One stuck dispatch the cron should mark timed_out + re-dispatch.

    Carries exactly what a re-dispatch needs (``pipeline_id`` is the operator's
    session id; ``stage`` + ``expected_status`` rebuild the typed envelope) plus
    the diagnostics (``last_seen``, ``idle_seconds``) for the ops log.
    """

    dispatch_id: str
    pipeline_id: str
    stage: str | None
    expected_status: str | None
    last_seen: datetime
    idle_seconds: float


def _parse_ts(value: Any) -> datetime | None:
    """Parse a timestamptz string/`datetime` into a tz-aware UTC datetime.

    Supabase returns ISO-8601 strings (often with a trailing ``Z``); we
    normalise to aware UTC so the arithmetic against ``now`` is correct. Returns
    None for missing/garbage values so the caller can fall back to another clock.
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


def _liveness_clock(row: dict[str, Any]) -> datetime | None:
    """The most recent sign of life for a dispatch row.

    The latest of ``last_heartbeat_at`` (a running heartbeat) and
    ``dispatched_at`` (the original kick). A ``dispatched`` row that never
    heartbeated is judged from ``dispatched_at``. Returns None when neither
    timestamp parses (a malformed row), which the caller treats as "cannot judge
    → skip" so the watchdog never re-dispatches on bad data.
    """
    candidates = [
        _parse_ts(row.get("last_heartbeat_at")),
        _parse_ts(row.get("dispatched_at")),
    ]
    present = [c for c in candidates if c is not None]
    return max(present) if present else None


def find_stuck_dispatches(
    rows: Iterable[dict[str, Any]],
    *,
    timeout: timedelta = DEFAULT_TIMEOUT,
    now: datetime | None = None,
) -> list[StuckDispatch]:
    """Return the open dispatches idle for ``>= timeout`` (the re-dispatch set).

    Pure: takes the candidate ``operator_dispatches`` rows, the timeout, and the
    current time; returns the stuck subset as :class:`StuckDispatch` records.
    Does no IO. A row is stuck when it is OPEN (``status in OPEN_STATUSES``) and
    its liveness clock (latest heartbeat or the kick) is at least ``timeout`` in
    the past. Terminal rows, rows with an unparseable liveness clock, and rows
    still inside the window are excluded. Results are sorted oldest-idle-first so
    the cron drains the most-stuck dispatches first.

    Args:
        rows: candidate dispatch rows (the caller passes the open ones; this
            function re-checks the status defensively).
        timeout: how long an open dispatch may be silent before it is stuck.
        now: the current time (tz-aware UTC). Defaults to ``datetime.now(UTC)``;
            tests pass an explicit clock for determinism.
    """
    current = now or datetime.now(timezone.utc)
    if current.tzinfo is None:
        current = current.replace(tzinfo=timezone.utc)

    stuck: list[StuckDispatch] = []
    for row in rows:
        status = row.get("status")
        if status not in OPEN_STATUSES:
            continue
        clock = _liveness_clock(row)
        if clock is None:
            # Malformed row — can't judge it; never re-dispatch on bad data.
            continue
        idle = current - clock
        if idle < timeout:
            continue
        dispatch_id = row.get("dispatch_id")
        pipeline_id = row.get("pipeline_id")
        if not dispatch_id or not pipeline_id:
            # The identity needed to re-dispatch is missing — skip defensively.
            continue
        stuck.append(
            StuckDispatch(
                dispatch_id=str(dispatch_id),
                pipeline_id=str(pipeline_id),
                stage=row.get("stage"),
                expected_status=row.get("expected_status"),
                last_seen=clock,
                idle_seconds=idle.total_seconds(),
            )
        )

    stuck.sort(key=lambda s: s.idle_seconds, reverse=True)
    return stuck


def is_stuck(
    row: dict[str, Any],
    *,
    timeout: timedelta = DEFAULT_TIMEOUT,
    now: datetime | None = None,
) -> bool:
    """Convenience predicate: is this single dispatch row stuck?

    Thin wrapper over :func:`find_stuck_dispatches` for call sites that judge one
    row at a time (and for readable tests).
    """
    return bool(find_stuck_dispatches([row], timeout=timeout, now=now))


__all__ = [
    "DEFAULT_TIMEOUT",
    "OPEN_STATUSES",
    "WATCHDOG_WIRING_NOTE",
    "StuckDispatch",
    "find_stuck_dispatches",
    "is_stuck",
]
