"""Pure-function tests for the work_item watchdog observer.

These DON'T need a DB -- the watchdog (``services.work_item_watchdog``) is
pure: it takes rows + a clock + thresholds and returns the rotation set.
The unit tests pin every branch of the "stuck" definition so the
scheduler-side wrapper can trust the decision without a DB round-trip in
CI's unit tier.

A small DB-backed test for the scheduler wrapper (``services.scheduler
.run_work_item_watchdog_once``) lives in ``test_observer_db.py`` so the
end-to-end requeue + parent-chain assertion fires against the real
schema.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from src.services.work_item_watchdog import (
    DEFAULT_HEARTBEAT_THRESHOLD,
    StaleConsumer,
    StuckWorkItem,
    compute_backoff_seconds,
    find_stale_consumers,
    find_stuck_work_items,
)


NOW = datetime(2026, 5, 26, 12, 0, 0, tzinfo=timezone.utc)


def _running_row(**overrides):
    row = {
        "id": "wi-1",
        "kind": "operator_dispatch",
        "pipeline_id": "p-1",
        "creative_id": None,
        "brief_id": None,
        "status": "running",
        "attempt": 1,
        "claim_token": "tok-1",
        "claimed_by": "consumer-A",
        "claimed_at": (NOW - timedelta(minutes=10)).isoformat(),
        "heartbeat_at": (NOW - timedelta(seconds=10)).isoformat(),
        "payload": {"instruction": "draft"},
    }
    row.update(overrides)
    return row


# ---------------------------------------------------------------------------
# find_stuck_work_items
# ---------------------------------------------------------------------------


def test_fresh_heartbeat_is_not_stuck() -> None:
    assert find_stuck_work_items([_running_row()], threshold=DEFAULT_HEARTBEAT_THRESHOLD, now=NOW) == []


def test_stale_heartbeat_is_stuck() -> None:
    row = _running_row(
        heartbeat_at=(NOW - timedelta(minutes=5)).isoformat()
    )
    stuck = find_stuck_work_items(
        [row], threshold=DEFAULT_HEARTBEAT_THRESHOLD, now=NOW
    )
    assert len(stuck) == 1
    assert isinstance(stuck[0], StuckWorkItem)
    assert stuck[0].work_item_id == "wi-1"
    assert stuck[0].kind == "operator_dispatch"
    assert stuck[0].attempt == 1
    assert stuck[0].claim_token == "tok-1"
    assert stuck[0].pipeline_id == "p-1"
    assert stuck[0].payload == {"instruction": "draft"}
    assert stuck[0].idle_seconds == 5 * 60


def test_claimed_without_heartbeat_falls_back_to_claimed_at() -> None:
    """A claimed-but-not-yet-heartbeated row uses claimed_at as the clock."""
    row = _running_row(
        status="claimed",
        heartbeat_at=None,
        claimed_at=(NOW - timedelta(minutes=5)).isoformat(),
    )
    stuck = find_stuck_work_items(
        [row], threshold=DEFAULT_HEARTBEAT_THRESHOLD, now=NOW
    )
    assert len(stuck) == 1
    assert stuck[0].idle_seconds == 5 * 60


def test_queued_row_is_never_stuck() -> None:
    """A queued row has no consumer; it's not in scope for the heartbeat watchdog."""
    row = _running_row(
        status="queued",
        claim_token=None,
        claimed_by=None,
        claimed_at=None,
        heartbeat_at=None,
    )
    assert find_stuck_work_items([row], threshold=DEFAULT_HEARTBEAT_THRESHOLD, now=NOW) == []


def test_terminal_rows_never_stuck() -> None:
    """Completed/failed/timed_out/cancelled rows are out of scope."""
    for status in ("completed", "failed", "timed_out", "cancelled"):
        row = _running_row(
            status=status,
            heartbeat_at=(NOW - timedelta(hours=2)).isoformat(),
        )
        assert (
            find_stuck_work_items(
                [row], threshold=DEFAULT_HEARTBEAT_THRESHOLD, now=NOW
            )
            == []
        )


def test_unparseable_timestamp_is_skipped() -> None:
    row = _running_row(heartbeat_at="not-a-date", claimed_at=None)
    assert (
        find_stuck_work_items(
            [row], threshold=DEFAULT_HEARTBEAT_THRESHOLD, now=NOW
        )
        == []
    )


def test_row_missing_identity_is_skipped() -> None:
    """A row without id or kind is malformed -- skip rather than act on bad data."""
    bad_id = _running_row(
        id=None, heartbeat_at=(NOW - timedelta(minutes=5)).isoformat()
    )
    bad_kind = _running_row(
        kind=None, heartbeat_at=(NOW - timedelta(minutes=5)).isoformat()
    )
    assert (
        find_stuck_work_items(
            [bad_id, bad_kind], threshold=DEFAULT_HEARTBEAT_THRESHOLD, now=NOW
        )
        == []
    )


def test_z_suffix_timestamp_parses() -> None:
    row = _running_row(
        heartbeat_at=(NOW - timedelta(minutes=5))
        .isoformat()
        .replace("+00:00", "Z")
    )
    assert (
        len(find_stuck_work_items([row], threshold=DEFAULT_HEARTBEAT_THRESHOLD, now=NOW))
        == 1
    )


def test_datetime_object_timestamp_parses() -> None:
    row = _running_row(
        heartbeat_at=NOW - timedelta(minutes=5),
        claimed_at=NOW - timedelta(minutes=10),
    )
    assert (
        len(find_stuck_work_items([row], threshold=DEFAULT_HEARTBEAT_THRESHOLD, now=NOW))
        == 1
    )


def test_naive_now_is_treated_as_utc() -> None:
    naive = NOW.replace(tzinfo=None)
    row = _running_row(
        heartbeat_at=(NOW - timedelta(minutes=5)).isoformat()
    )
    assert (
        len(find_stuck_work_items([row], threshold=DEFAULT_HEARTBEAT_THRESHOLD, now=naive))
        == 1
    )


def test_multiple_stuck_sorted_oldest_first() -> None:
    rows = [
        _running_row(
            id="wi-recent",
            heartbeat_at=(NOW - timedelta(minutes=3)).isoformat(),
        ),
        _running_row(
            id="wi-oldest",
            heartbeat_at=(NOW - timedelta(hours=1)).isoformat(),
        ),
        _running_row(
            id="wi-mid", heartbeat_at=(NOW - timedelta(minutes=10)).isoformat()
        ),
    ]
    stuck = find_stuck_work_items(rows, threshold=DEFAULT_HEARTBEAT_THRESHOLD, now=NOW)
    assert [s.work_item_id for s in stuck] == ["wi-oldest", "wi-mid", "wi-recent"]


def test_custom_threshold_respected() -> None:
    row = _running_row(
        heartbeat_at=(NOW - timedelta(minutes=2)).isoformat()
    )
    # 2 minutes is below the default 2 min threshold.
    assert (
        find_stuck_work_items(
            [row], threshold=timedelta(minutes=10), now=NOW
        )
        == []
    )
    # ...above a 30-sec threshold.
    stuck = find_stuck_work_items(
        [row], threshold=timedelta(seconds=30), now=NOW
    )
    assert len(stuck) == 1


def test_now_defaults_to_real_clock() -> None:
    """Without an explicit clock, a row stale by hours is stuck."""
    row = _running_row(
        heartbeat_at=(datetime.now(timezone.utc) - timedelta(hours=2)).isoformat()
    )
    assert len(find_stuck_work_items([row])) == 1


def test_payload_non_dict_defaults_to_empty() -> None:
    """A defective payload (string / None) is coerced to {} to keep retry safe."""
    row = _running_row(
        heartbeat_at=(NOW - timedelta(minutes=5)).isoformat(), payload=None
    )
    stuck = find_stuck_work_items([row], threshold=DEFAULT_HEARTBEAT_THRESHOLD, now=NOW)
    assert len(stuck) == 1
    assert stuck[0].payload == {}


# ---------------------------------------------------------------------------
# compute_backoff_seconds
# ---------------------------------------------------------------------------


def test_backoff_grows_exponentially() -> None:
    assert compute_backoff_seconds(attempt=0) == 60
    assert compute_backoff_seconds(attempt=1) == 120
    assert compute_backoff_seconds(attempt=2) == 240
    assert compute_backoff_seconds(attempt=3) == 480


def test_backoff_capped() -> None:
    # 60 * 2^10 = 61_440 -- way over the cap.
    assert compute_backoff_seconds(attempt=10) == 3600
    assert compute_backoff_seconds(attempt=100) == 3600


def test_backoff_floors_at_attempt_zero() -> None:
    """A negative attempt count clamps to zero (defensive)."""
    assert compute_backoff_seconds(attempt=-3) == 60


# ---------------------------------------------------------------------------
# find_stale_consumers
# ---------------------------------------------------------------------------


def _consumer(**overrides):
    row = {
        "id": "consumer-A",
        "kind": "operator_dispatch",
        "status": "live",
        "last_seen_at": (NOW - timedelta(seconds=5)).isoformat(),
    }
    row.update(overrides)
    return row


def test_fresh_consumer_not_stale() -> None:
    assert find_stale_consumers([_consumer()], now=NOW) == []


def test_degraded_after_2x_interval() -> None:
    row = _consumer(last_seen_at=(NOW - timedelta(seconds=65)).isoformat())
    stale = find_stale_consumers([row], now=NOW)
    assert len(stale) == 1
    assert isinstance(stale[0], StaleConsumer)
    assert stale[0].target_status == "degraded"


def test_down_after_4x_interval() -> None:
    row = _consumer(last_seen_at=(NOW - timedelta(seconds=125)).isoformat())
    stale = find_stale_consumers([row], now=NOW)
    assert len(stale) == 1
    assert stale[0].target_status == "down"


def test_consumer_already_in_target_skipped() -> None:
    """A consumer already 'down' is not re-flipped to 'down'."""
    row = _consumer(
        status="down", last_seen_at=(NOW - timedelta(minutes=10)).isoformat()
    )
    assert find_stale_consumers([row], now=NOW) == []


def test_stopped_consumer_left_alone() -> None:
    """A cleanly stopped consumer doesn't degrade to 'down'."""
    row = _consumer(
        status="stopped", last_seen_at=(NOW - timedelta(hours=2)).isoformat()
    )
    assert find_stale_consumers([row], now=NOW) == []


def test_missing_id_skipped() -> None:
    row = _consumer(id=None, last_seen_at=(NOW - timedelta(minutes=10)).isoformat())
    assert find_stale_consumers([row], now=NOW) == []


def test_unparseable_last_seen_skipped() -> None:
    row = _consumer(last_seen_at="not-a-date")
    assert find_stale_consumers([row], now=NOW) == []


def test_stale_consumers_sorted_oldest_first() -> None:
    rows = [
        _consumer(id="c-fresh", last_seen_at=(NOW - timedelta(seconds=5)).isoformat()),
        _consumer(id="c-down", last_seen_at=(NOW - timedelta(minutes=10)).isoformat()),
        _consumer(
            id="c-degraded", last_seen_at=(NOW - timedelta(seconds=70)).isoformat()
        ),
    ]
    stale = find_stale_consumers(rows, now=NOW)
    assert [s.consumer_id for s in stale] == ["c-down", "c-degraded"]
