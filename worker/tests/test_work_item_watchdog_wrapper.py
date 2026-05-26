"""Unit tests for the scheduler wrapper around the pure watchdog observer.

The wrapper (``services.scheduler.run_work_item_watchdog_once``) reads held
rows + consumer rows from Supabase, calls the pure functions in
``services.work_item_watchdog``, and writes the resulting transitions. These
tests pin the in-memory contract: with a seeded FakeSupabase, the right rows
get rotated / requeued / dead-lettered / consumer-flipped.

The DB-level invariants (CHECK constraints firing on the rotation UPDATE)
live in ``tests/queue/`` (the integration tier); this is the seam test.
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone

import pytest

from src.config import Settings
from src.services.scheduler import run_work_item_watchdog_once


NOW = datetime(2026, 5, 26, 12, 0, 0, tzinfo=timezone.utc)


def _settings(**overrides):
    base = dict(
        worker_shared_secret="test",
        work_item_max_attempts=3,
        work_item_heartbeat_threshold_s=60,
        work_item_consumer_heartbeat_s=30,
        work_item_watchdog_max_per_pass=10,
        work_item_backoff_base_s=10,
        work_item_backoff_cap_s=600,
    )
    base.update(overrides)
    return Settings(**base)  # type: ignore[call-arg]


def _stale_row(idle_seconds: float = 300, attempt: int = 1) -> dict:
    """One claimed/running row whose heartbeat is `idle_seconds` old."""
    stale_at = (NOW - timedelta(seconds=idle_seconds)).isoformat()
    return {
        "id": f"wi-stale-{idle_seconds}-{attempt}",
        "kind": "operator_dispatch",
        "pipeline_id": "p-1",
        "creative_id": None,
        "brief_id": None,
        "status": "running",
        "attempt": attempt,
        "claim_token": "tok-1",
        "claimed_by": "consumer-A",
        "claimed_at": stale_at,
        "heartbeat_at": stale_at,
        "payload": {"x": 1},
        "idempotency_key": f"op-{idle_seconds}-{attempt}",
        "parent_work_item_id": None,
        "created_by": "test",
    }


def test_run_watchdog_no_stuck_no_actions(fake_supabase) -> None:
    """An empty held set + empty consumer set leaves nothing to do."""
    counts = asyncio.run(
        run_work_item_watchdog_once(fake_supabase, settings=_settings(), now=NOW)
    )
    assert counts == {
        "rotated": 0,
        "requeued": 0,
        "dead_lettered": 0,
        "consumers_flipped": 0,
    }


def test_run_watchdog_requeues_stuck_row(fake_supabase) -> None:
    """A stale row + attempt < max_attempts gets timed_out + requeued."""
    row = _stale_row(idle_seconds=300, attempt=1)
    fake_supabase.seed("work_item", [row])
    # The enqueue probe will return None (no existing row by the retry key).
    fake_supabase.set_single("work_item", None)
    counts = asyncio.run(
        run_work_item_watchdog_once(fake_supabase, settings=_settings(), now=NOW)
    )
    assert counts["rotated"] == 1
    assert counts["requeued"] == 1
    assert counts["dead_lettered"] == 0
    # The original row was UPDATEd to status=timed_out.
    rotations = [
        u for t, u in fake_supabase.updates
        if t == "work_item" and u.get("status") == "timed_out"
    ]
    assert len(rotations) == 1
    assert rotations[0]["error_kind"] == "heartbeat_stale"
    # A new queued row was inserted with parent_work_item_id pointing back.
    inserts = [
        r for t, r in fake_supabase.inserts
        if t == "work_item" and r.get("parent_work_item_id") == row["id"]
    ]
    assert len(inserts) == 1


def test_run_watchdog_dead_letters_at_max_attempts(fake_supabase) -> None:
    """At attempt == max_attempts the row is failed, not requeued."""
    row = _stale_row(idle_seconds=300, attempt=3)
    fake_supabase.seed("work_item", [row])
    counts = asyncio.run(
        run_work_item_watchdog_once(fake_supabase, settings=_settings(), now=NOW)
    )
    assert counts["rotated"] == 1
    assert counts["dead_lettered"] == 1
    assert counts["requeued"] == 0
    failures = [
        u for t, u in fake_supabase.updates
        if t == "work_item" and u.get("status") == "failed"
    ]
    assert len(failures) == 1
    assert failures[0]["error_kind"] == "max_attempts_exceeded"
    # No retry row was inserted.
    retry_inserts = [
        r for t, r in fake_supabase.inserts
        if t == "work_item" and r.get("parent_work_item_id") == row["id"]
    ]
    assert retry_inserts == []


def test_run_watchdog_flips_stale_consumer(fake_supabase) -> None:
    """A consumer past 4x heartbeat interval flips to 'down'."""
    stale_at = (NOW - timedelta(minutes=5)).isoformat()
    fake_supabase.seed(
        "work_item_consumers",
        [
            {
                "id": "daemon-1",
                "kind": "operator_dispatch",
                "status": "live",
                "last_seen_at": stale_at,
            }
        ],
    )
    counts = asyncio.run(
        run_work_item_watchdog_once(fake_supabase, settings=_settings(), now=NOW)
    )
    assert counts["consumers_flipped"] == 1
    flips = [
        u for t, u in fake_supabase.updates
        if t == "work_item_consumers" and u.get("status") == "down"
    ]
    assert len(flips) == 1


def test_run_watchdog_respects_max_per_pass(fake_supabase) -> None:
    """A backlog larger than ``work_item_watchdog_max_per_pass`` is bounded."""
    rows = [_stale_row(idle_seconds=600, attempt=1) for _ in range(5)]
    # Make ids unique so the FakeSupabase update filter works against each row.
    for i, r in enumerate(rows):
        r["id"] = f"wi-many-{i}"
    fake_supabase.seed("work_item", rows)
    fake_supabase.set_single("work_item", None)

    counts = asyncio.run(
        run_work_item_watchdog_once(
            fake_supabase,
            settings=_settings(work_item_watchdog_max_per_pass=2),
            now=NOW,
        )
    )
    # Only 2 rotations, even with 5 stale rows in the queue.
    assert counts["rotated"] == 2
    assert counts["requeued"] == 2


def test_run_watchdog_one_bad_row_does_not_sink_pass(
    fake_supabase, monkeypatch
) -> None:
    """A per-row failure is logged but the rest of the pass continues."""
    rows = [
        _stale_row(idle_seconds=600, attempt=1),
        _stale_row(idle_seconds=300, attempt=1),
    ]
    rows[0]["id"] = "wi-bad-row"
    rows[1]["id"] = "wi-good-row"
    fake_supabase.seed("work_item", rows)
    fake_supabase.set_single("work_item", None)

    # Patch _rotate_stuck_work_item to raise for one specific id.
    from src.services import scheduler as sched

    original = sched._rotate_stuck_work_item

    def fake_rotate(sb, item, **kw):
        if item.work_item_id == "wi-bad-row":
            raise RuntimeError("rotation failed")
        return original(sb, item, **kw)

    monkeypatch.setattr(sched, "_rotate_stuck_work_item", fake_rotate)

    counts = asyncio.run(
        run_work_item_watchdog_once(fake_supabase, settings=_settings(), now=NOW)
    )
    # Only one row succeeded; the bad row was skipped.
    assert counts["rotated"] == 1


def test_run_watchdog_one_bad_consumer_does_not_sink_pass(
    fake_supabase, monkeypatch
) -> None:
    """A consumer-flip failure is logged but the rest of the pass continues."""
    stale = (NOW - timedelta(minutes=5)).isoformat()
    fake_supabase.seed(
        "work_item_consumers",
        [
            {"id": "daemon-bad", "kind": "operator_dispatch", "status": "live", "last_seen_at": stale},
            {"id": "daemon-good", "kind": "operator_dispatch", "status": "live", "last_seen_at": stale},
        ],
    )

    from src.services import scheduler as sched

    original = sched._flip_stale_consumer

    def fake_flip(sb, consumer):
        if consumer.consumer_id == "daemon-bad":
            raise RuntimeError("flip failed")
        return original(sb, consumer)

    monkeypatch.setattr(sched, "_flip_stale_consumer", fake_flip)

    counts = asyncio.run(
        run_work_item_watchdog_once(fake_supabase, settings=_settings(), now=NOW)
    )
    assert counts["consumers_flipped"] == 1
