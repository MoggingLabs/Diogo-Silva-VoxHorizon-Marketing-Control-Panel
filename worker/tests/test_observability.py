"""Unit tests for the observability primitives (P5.6 / #369).

Covers the three surfaces in :mod:`services.observability`:

  * correlation-id binding (bind / clear / nested context manager);
  * the stuck-dispatch + stuck-outbox watchdog pure functions
    (timeout boundary, open-vs-terminal status, heartbeat precedence,
    unparseable-timestamp safety, oldest-first ordering);
  * the metrics snapshot roll-up (outbox depth, in-flight dispatches,
    breaker map passthrough, cost-vs-cap, resilient reads).
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import structlog

from src.services import observability
from src.services.observability import (
    metrics_snapshot,
    stuck_dispatches,
    stuck_outbox,
)

from .conftest import FakeSupabase


NOW = datetime(2026, 5, 22, 12, 0, 0, tzinfo=timezone.utc)


def _ago(seconds: float) -> str:
    return (NOW - timedelta(seconds=seconds)).isoformat()


# ---------------------------------------------------------------------------
# Correlation-id binding
# ---------------------------------------------------------------------------


def test_bind_and_clear_pipeline() -> None:
    observability.clear_pipeline()
    observability.bind_pipeline("p-1", route="launch")
    ctx = structlog.contextvars.get_contextvars()
    assert ctx["pipeline_id"] == "p-1"
    assert ctx["route"] == "launch"
    observability.clear_pipeline()
    assert structlog.contextvars.get_contextvars() == {}


def test_bind_pipeline_none_is_noop() -> None:
    observability.clear_pipeline()
    observability.bind_pipeline(None)
    assert structlog.contextvars.get_contextvars() == {}


def test_bound_pipeline_restores_outer_scope() -> None:
    observability.clear_pipeline()
    observability.bind_pipeline("outer")
    with observability.bound_pipeline("inner", stage="copy"):
        ctx = structlog.contextvars.get_contextvars()
        assert ctx["pipeline_id"] == "inner"
        assert ctx["stage"] == "copy"
    # On exit, the outer binding is restored and the inner-only key is gone.
    ctx = structlog.contextvars.get_contextvars()
    assert ctx["pipeline_id"] == "outer"
    assert "stage" not in ctx
    observability.clear_pipeline()


# ---------------------------------------------------------------------------
# stuck_dispatches watchdog
# ---------------------------------------------------------------------------


def test_stuck_dispatch_flagged_past_timeout() -> None:
    rows = [
        {
            "pipeline_id": "p-1",
            "dispatch_id": "d-1",
            "status": "running",
            "dispatched_at": _ago(1000),
        }
    ]
    out = stuck_dispatches(rows, now=NOW, timeout_s=900)
    assert len(out) == 1
    assert out[0].kind == "dispatch"
    assert out[0].ref == "d-1"
    assert out[0].age_s == 1000


def test_fresh_dispatch_not_flagged() -> None:
    rows = [
        {"dispatch_id": "d-1", "status": "dispatched", "dispatched_at": _ago(60)}
    ]
    assert stuck_dispatches(rows, now=NOW, timeout_s=900) == []


def test_terminal_dispatch_never_flagged() -> None:
    rows = [
        {"dispatch_id": "d-1", "status": "completed", "dispatched_at": _ago(9999)},
        {"dispatch_id": "d-2", "status": "failed", "dispatched_at": _ago(9999)},
        {"dispatch_id": "d-3", "status": "timed_out", "dispatched_at": _ago(9999)},
    ]
    assert stuck_dispatches(rows, now=NOW, timeout_s=900) == []


def test_heartbeat_takes_precedence_over_dispatched_at() -> None:
    # Dispatched long ago, but a recent heartbeat means it's alive → not stuck.
    rows = [
        {
            "dispatch_id": "d-1",
            "status": "running",
            "dispatched_at": _ago(5000),
            "last_heartbeat_at": _ago(10),
        }
    ]
    assert stuck_dispatches(rows, now=NOW, timeout_s=900) == []


def test_unparseable_dispatch_timestamp_skipped() -> None:
    rows = [
        {"dispatch_id": "d-1", "status": "running", "dispatched_at": "not-a-date"},
        {"dispatch_id": "d-2", "status": "running", "dispatched_at": None},
    ]
    assert stuck_dispatches(rows, now=NOW, timeout_s=900) == []


def test_stuck_dispatches_sorted_oldest_first() -> None:
    rows = [
        {"dispatch_id": "younger", "status": "running", "dispatched_at": _ago(1000)},
        {"dispatch_id": "older", "status": "running", "dispatched_at": _ago(5000)},
    ]
    out = stuck_dispatches(rows, now=NOW, timeout_s=900)
    assert [i.ref for i in out] == ["older", "younger"]


# ---------------------------------------------------------------------------
# stuck_outbox watchdog
# ---------------------------------------------------------------------------


def test_stuck_outbox_flagged_past_timeout() -> None:
    rows = [
        {
            "pipeline_id": "p-1",
            "idempotency_key": "k-1",
            "status": "pending",
            "created_at": _ago(600),
        }
    ]
    out = stuck_outbox(rows, now=NOW, timeout_s=300)
    assert len(out) == 1
    assert out[0].kind == "outbox"
    assert out[0].ref == "k-1"


def test_terminal_outbox_never_flagged() -> None:
    rows = [
        {"idempotency_key": "k-1", "status": "done", "created_at": _ago(9999)},
        {"idempotency_key": "k-2", "status": "dead", "created_at": _ago(9999)},
        {"idempotency_key": "k-3", "status": "failed", "created_at": _ago(9999)},
    ]
    assert stuck_outbox(rows, now=NOW, timeout_s=300) == []


def test_fresh_outbox_not_flagged() -> None:
    rows = [{"idempotency_key": "k-1", "status": "inflight", "created_at": _ago(10)}]
    assert stuck_outbox(rows, now=NOW, timeout_s=300) == []


def test_outbox_falls_back_to_id_when_no_key() -> None:
    rows = [{"id": "row-id", "status": "pending", "created_at": _ago(9999)}]
    out = stuck_outbox(rows, now=NOW, timeout_s=300)
    assert out[0].ref == "row-id"


def test_unparseable_outbox_timestamp_skipped() -> None:
    rows = [{"idempotency_key": "k-1", "status": "pending", "created_at": "junk"}]
    assert stuck_outbox(rows, now=NOW, timeout_s=300) == []


def test_dispatch_accepts_datetime_timestamp() -> None:
    # A native datetime (not an ISO string) is parsed too — the naive form is
    # treated as UTC.
    naive = (NOW - timedelta(seconds=5000)).replace(tzinfo=None)
    rows = [{"dispatch_id": "d-1", "status": "running", "dispatched_at": naive}]
    out = stuck_dispatches(rows, now=NOW, timeout_s=900)
    assert len(out) == 1
    assert out[0].ref == "d-1"


# ---------------------------------------------------------------------------
# metrics_snapshot
# ---------------------------------------------------------------------------


def test_metrics_snapshot_counts_outbox_and_dispatches(
    fake_supabase: FakeSupabase,
) -> None:
    fake_supabase.seed(
        "_legacy_integration_outbox",
        [
            {"status": "pending"},
            {"status": "pending"},
            {"status": "inflight"},
            {"status": "failed"},
            {"status": "dead"},
            {"status": "done"},  # not reported
        ],
    )
    fake_supabase.seed(
        "_legacy_operator_dispatches",
        [
            {"status": "dispatched"},
            {"status": "running"},
            {"status": "completed"},  # not in-flight
        ],
    )
    snap = metrics_snapshot(
        fake_supabase,
        breaker_states={"services.leadconnectorhq.com": "closed"},
        cost_total_usd=25.0,
        cost_cap_usd=100.0,
        now=NOW,
    )
    assert snap["outbox"]["pending"] == 2
    assert snap["outbox"]["inflight"] == 1
    assert snap["outbox"]["failed"] == 1
    assert snap["outbox"]["dead"] == 1
    assert snap["outbox"]["depth"] == 3  # pending + inflight
    assert snap["dispatches"]["in_flight"] == 2
    assert snap["breakers"] == {"services.leadconnectorhq.com": "closed"}
    assert snap["cost"]["total_usd"] == 25.0
    assert snap["cost"]["over_cap"] is False
    assert snap["cost"]["remaining_usd"] == 75.0


def test_metrics_snapshot_over_cap(fake_supabase: FakeSupabase) -> None:
    snap = metrics_snapshot(
        fake_supabase, cost_total_usd=150.0, cost_cap_usd=100.0, now=NOW
    )
    assert snap["cost"]["over_cap"] is True
    assert snap["cost"]["remaining_usd"] == -50.0


def test_metrics_snapshot_no_cap(fake_supabase: FakeSupabase) -> None:
    snap = metrics_snapshot(fake_supabase, cost_total_usd=5.0, cost_cap_usd=None, now=NOW)
    assert snap["cost"]["cap_usd"] is None
    assert snap["cost"]["over_cap"] is False
    assert snap["cost"]["remaining_usd"] is None


def test_metrics_snapshot_resilient_to_read_failure() -> None:
    class _Boom:
        def table(self, _name: str):  # noqa: ANN001
            raise RuntimeError("table read failed")

    snap = metrics_snapshot(_Boom(), now=NOW)
    # Reads degrade to empty; the snapshot still returns its full shape.
    assert snap["outbox"]["depth"] == 0
    assert snap["dispatches"]["in_flight"] == 0
    assert snap["breakers"] == {}
