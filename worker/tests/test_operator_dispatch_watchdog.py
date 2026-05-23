"""Unit tests for the stuck-dispatch watchdog (pure function).

The watchdog is IO-free — it takes the open ``operator_dispatches`` rows + a
timeout + an explicit clock and returns the stuck subset. These tests pin every
branch of the "stuck" definition (open vs terminal status, heartbeat vs kick
liveness clock, inside vs past the window, malformed rows) so the later cron
wiring can trust the decision.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from src.services.operator_dispatch_watchdog import (
    DEFAULT_TIMEOUT,
    OPEN_STATUSES,
    StuckDispatch,
    find_stuck_dispatches,
    is_stuck,
)


NOW = datetime(2026, 5, 22, 12, 0, 0, tzinfo=timezone.utc)


def _row(**overrides: object) -> dict[str, object]:
    """A dispatched row kicked 1 minute ago (healthy by default)."""
    row: dict[str, object] = {
        "dispatch_id": "d-1",
        "pipeline_id": "p-1",
        "stage": "copy",
        "expected_status": "copy",
        "status": "dispatched",
        "dispatched_at": (NOW - timedelta(minutes=1)).isoformat(),
        "last_heartbeat_at": None,
    }
    row.update(overrides)
    return row


# ---------------------------------------------------------------------------
# The "stuck" core
# ---------------------------------------------------------------------------


def test_recent_dispatch_is_not_stuck() -> None:
    assert find_stuck_dispatches([_row()], timeout=DEFAULT_TIMEOUT, now=NOW) == []


def test_old_dispatch_without_heartbeat_is_stuck() -> None:
    row = _row(dispatched_at=(NOW - timedelta(minutes=30)).isoformat())
    stuck = find_stuck_dispatches([row], timeout=DEFAULT_TIMEOUT, now=NOW)
    assert len(stuck) == 1
    assert isinstance(stuck[0], StuckDispatch)
    assert stuck[0].dispatch_id == "d-1"
    assert stuck[0].pipeline_id == "p-1"
    assert stuck[0].stage == "copy"
    assert stuck[0].expected_status == "copy"
    assert stuck[0].idle_seconds == 30 * 60


def test_recent_heartbeat_keeps_old_dispatch_alive() -> None:
    """A running dispatch kicked long ago but heartbeating recently is healthy:
    the liveness clock is the LATEST of heartbeat/kick."""
    row = _row(
        status="running",
        dispatched_at=(NOW - timedelta(hours=2)).isoformat(),
        last_heartbeat_at=(NOW - timedelta(minutes=2)).isoformat(),
    )
    assert find_stuck_dispatches([row], timeout=DEFAULT_TIMEOUT, now=NOW) == []


def test_stale_heartbeat_is_stuck() -> None:
    row = _row(
        status="running",
        dispatched_at=(NOW - timedelta(hours=2)).isoformat(),
        last_heartbeat_at=(NOW - timedelta(minutes=20)).isoformat(),
    )
    stuck = find_stuck_dispatches([row], timeout=DEFAULT_TIMEOUT, now=NOW)
    assert len(stuck) == 1
    assert stuck[0].idle_seconds == 20 * 60


def test_exactly_at_timeout_is_stuck() -> None:
    """The boundary is inclusive (idle >= timeout)."""
    row = _row(dispatched_at=(NOW - DEFAULT_TIMEOUT).isoformat())
    assert len(find_stuck_dispatches([row], timeout=DEFAULT_TIMEOUT, now=NOW)) == 1


def test_just_under_timeout_is_not_stuck() -> None:
    row = _row(dispatched_at=(NOW - DEFAULT_TIMEOUT + timedelta(seconds=1)).isoformat())
    assert find_stuck_dispatches([row], timeout=DEFAULT_TIMEOUT, now=NOW) == []


# ---------------------------------------------------------------------------
# Terminal statuses are never re-dispatched
# ---------------------------------------------------------------------------


def test_terminal_statuses_never_stuck() -> None:
    old = (NOW - timedelta(hours=5)).isoformat()
    for status in ("completed", "failed", "timed_out"):
        row = _row(status=status, dispatched_at=old, last_heartbeat_at=old)
        assert find_stuck_dispatches([row], timeout=DEFAULT_TIMEOUT, now=NOW) == []


def test_open_statuses_set() -> None:
    assert OPEN_STATUSES == frozenset({"dispatched", "running"})


# ---------------------------------------------------------------------------
# Malformed / incomplete rows are skipped, never re-dispatched on bad data
# ---------------------------------------------------------------------------


def test_row_without_timestamps_is_skipped() -> None:
    row = _row(dispatched_at=None, last_heartbeat_at=None)
    assert find_stuck_dispatches([row], timeout=DEFAULT_TIMEOUT, now=NOW) == []


def test_unparseable_timestamp_is_skipped() -> None:
    row = _row(dispatched_at="not-a-date", last_heartbeat_at=None)
    assert find_stuck_dispatches([row], timeout=DEFAULT_TIMEOUT, now=NOW) == []


def test_row_missing_identity_is_skipped() -> None:
    old = (NOW - timedelta(hours=1)).isoformat()
    assert find_stuck_dispatches(
        [_row(dispatched_at=old, dispatch_id=None)], timeout=DEFAULT_TIMEOUT, now=NOW
    ) == []
    assert find_stuck_dispatches(
        [_row(dispatched_at=old, pipeline_id=None)], timeout=DEFAULT_TIMEOUT, now=NOW
    ) == []


# ---------------------------------------------------------------------------
# Multiple rows: ordering + mixed
# ---------------------------------------------------------------------------


def test_multiple_stuck_sorted_oldest_idle_first() -> None:
    rows = [
        _row(dispatch_id="d-recent", dispatched_at=(NOW - timedelta(minutes=16)).isoformat()),
        _row(dispatch_id="d-oldest", dispatched_at=(NOW - timedelta(hours=3)).isoformat()),
        _row(dispatch_id="d-healthy", dispatched_at=(NOW - timedelta(minutes=1)).isoformat()),
        _row(dispatch_id="d-done", status="completed", dispatched_at=(NOW - timedelta(hours=9)).isoformat()),
    ]
    stuck = find_stuck_dispatches(rows, timeout=DEFAULT_TIMEOUT, now=NOW)
    assert [s.dispatch_id for s in stuck] == ["d-oldest", "d-recent"]


def test_custom_timeout_respected() -> None:
    row = _row(dispatched_at=(NOW - timedelta(minutes=5)).isoformat())
    # 5 minutes idle: not stuck at the 15m default, stuck at a 2m timeout.
    assert find_stuck_dispatches([row], timeout=timedelta(minutes=15), now=NOW) == []
    assert len(find_stuck_dispatches([row], timeout=timedelta(minutes=2), now=NOW)) == 1


# ---------------------------------------------------------------------------
# Timestamp parsing variants + naive `now`
# ---------------------------------------------------------------------------


def test_z_suffix_timestamp_parses() -> None:
    row = _row(dispatched_at=(NOW - timedelta(minutes=30)).isoformat().replace("+00:00", "Z"))
    assert len(find_stuck_dispatches([row], timeout=DEFAULT_TIMEOUT, now=NOW)) == 1


def test_datetime_object_timestamp_accepted() -> None:
    row = _row(dispatched_at=NOW - timedelta(minutes=30), last_heartbeat_at=None)
    assert len(find_stuck_dispatches([row], timeout=DEFAULT_TIMEOUT, now=NOW)) == 1


def test_naive_now_is_treated_as_utc() -> None:
    naive = NOW.replace(tzinfo=None)
    row = _row(dispatched_at=(NOW - timedelta(minutes=30)).isoformat())
    assert len(find_stuck_dispatches([row], timeout=DEFAULT_TIMEOUT, now=naive)) == 1


def test_now_defaults_to_real_clock() -> None:
    """With no explicit clock, a row kicked far in the past is stuck."""
    row = _row(
        dispatched_at=(datetime.now(timezone.utc) - timedelta(hours=2)).isoformat(),
        last_heartbeat_at=None,
    )
    assert len(find_stuck_dispatches([row])) == 1


# ---------------------------------------------------------------------------
# is_stuck convenience predicate
# ---------------------------------------------------------------------------


def test_is_stuck_true_and_false() -> None:
    assert is_stuck(
        _row(dispatched_at=(NOW - timedelta(hours=1)).isoformat()),
        timeout=DEFAULT_TIMEOUT,
        now=NOW,
    )
    assert not is_stuck(_row(), timeout=DEFAULT_TIMEOUT, now=NOW)
