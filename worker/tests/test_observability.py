"""Unit tests for the observability primitives (P5.6 / #369).

Covers the two surfaces in :mod:`services.observability`:

  * correlation-id binding (bind / clear / nested context manager);
  * the metrics snapshot roll-up (outbox depth, in-flight dispatches,
    breaker map passthrough, cost-vs-cap, resilient reads).
"""

from __future__ import annotations

from datetime import datetime, timezone

import structlog

from src.services import observability
from src.services.observability import metrics_snapshot

from .conftest import FakeSupabase


NOW = datetime(2026, 5, 22, 12, 0, 0, tzinfo=timezone.utc)


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
# metrics_snapshot
# ---------------------------------------------------------------------------


def test_metrics_snapshot_counts_outbox_and_dispatches(
    fake_supabase: FakeSupabase,
) -> None:
    # Silent-failure PR-6: outbox + dispatch metrics come off the unified
    # work_item queue. Outbox kinds map onto the four reported buckets:
    # queued->pending, claimed/running->inflight, failed->failed, timed_out->dead.
    fake_supabase.seed(
        "work_item",
        [
            {"kind": "outbox_meta_record_launch", "status": "queued"},
            {"kind": "outbox_drive_finalize_verified", "status": "queued"},
            {"kind": "outbox_ghl_send", "status": "running"},
            {"kind": "outbox_meta_record_launch", "status": "failed"},
            {"kind": "outbox_ghl_send", "status": "timed_out"},
            {"kind": "outbox_meta_record_launch", "status": "completed"},  # not reported
            {"kind": "outbox_ghl_send", "status": "cancelled"},  # not reported
            # A non-outbox kind is never counted as outbox depth.
            {"kind": "kie_video_render", "status": "queued"},
            # operator_dispatch rows: only claimed/running are in-flight.
            {"kind": "operator_dispatch", "status": "claimed"},
            {"kind": "operator_dispatch", "status": "running"},
            {"kind": "operator_dispatch", "status": "completed"},  # not in-flight
            {"kind": "operator_dispatch", "status": "queued"},  # not in-flight
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
