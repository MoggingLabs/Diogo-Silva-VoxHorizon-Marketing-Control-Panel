"""Tests for ops alert delivery (E5.6 / #526).

The watchdog ticks classify operational problems and log them; E5.6 adds the
DELIVERY half: paging a Slack ops channel when a problem is detected. We cover
the four required behaviours plus the classification + throttle logic:

  * an alert FIRES on a detected problem (stuck dispatch, outbox dead letters,
    backlog, open breaker, cost over cap);
  * repeated alerts are THROTTLED / de-duped (page on transition into bad, not
    every tick) and RE-ARM after a return to healthy;
  * delivery NEVER raises on a Slack failure (outage, non-ok body, missing
    channel) and never blocks the loop;
  * NO alert is sent when the system is healthy;
  * the observability tick wires evaluate + deliver end to end.
"""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from src.config import get_settings
from src.services import scheduler
from src.services.observability import StuckItem

from .conftest import FakeSupabase


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _settings(**over: object):  # noqa: ANN202
    """Fresh Settings from the harness env, with optional field overrides."""
    get_settings.cache_clear()
    s = get_settings()
    return s.model_copy(update=dict(over)) if over else s


def _stuck(ref: str = "d-1", age_s: float = 1000.0, pipeline_id: str = "p-1") -> StuckItem:
    return StuckItem(
        kind="dispatch",
        pipeline_id=pipeline_id,
        ref=ref,
        age_s=age_s,
        row={"dispatch_id": ref},
    )


def _metrics(
    *,
    dead: int = 0,
    failed: int = 0,
    depth: int = 0,
    breakers: dict[str, str] | None = None,
    over_cap: bool = False,
) -> dict[str, Any]:
    return {
        "outbox": {"pending": 0, "inflight": 0, "failed": failed, "dead": dead, "depth": depth},
        "dispatches": {"in_flight": 0},
        "breakers": breakers or {},
        "cost": {"total_usd": 200.0, "cap_usd": 100.0, "over_cap": over_cap},
    }


@pytest.fixture(autouse=True)
def _reset_throttle() -> None:
    """Each test starts with a fresh process-wide throttle."""
    scheduler.reset_alert_throttle()
    yield
    scheduler.reset_alert_throttle()


@pytest.fixture
def slack_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SLACK_BOT_TOKEN", "xoxb-test")
    monkeypatch.setenv("SLACK_OPS_CHANNEL_ID", "C-OPS-1")


@pytest.fixture
def capture_slack(monkeypatch: pytest.MonkeyPatch) -> dict[str, Any]:
    """Replace the shared Slack sender with a recorder.

    State knobs: ``ok`` (return value), ``raise`` (exception to raise). Calls are
    appended to ``calls`` for assertions.
    """
    from src.services import approval_notifications

    state: dict[str, Any] = {"calls": [], "ok": True, "raise": None}

    async def _fake(*, token, channel, text, blocks=None, context=None):  # noqa: ANN001, ANN202
        state["calls"].append(
            {"token": token, "channel": channel, "text": text, "blocks": blocks, "context": context}
        )
        if state["raise"] is not None:
            raise state["raise"]
        return state["ok"]

    monkeypatch.setattr(approval_notifications, "post_slack_message", _fake)
    return state


# ---------------------------------------------------------------------------
# evaluate_alert_conditions (pure classification)
# ---------------------------------------------------------------------------


def test_evaluate_flags_stuck_dispatch() -> None:
    conds = scheduler.evaluate_alert_conditions(
        _settings(), stuck_dispatches=[_stuck(age_s=1000)], metrics=_metrics()
    )
    kinds = {c.kind for c in conds}
    assert "stuck_dispatch" in kinds
    sd = next(c for c in conds if c.kind == "stuck_dispatch")
    assert sd.severity == "critical"
    assert "d-1" in sd.detail


def test_evaluate_ignores_dispatch_below_age_threshold() -> None:
    # Aged 500s with a 900s SLO -> below threshold -> not flagged.
    conds = scheduler.evaluate_alert_conditions(
        _settings(ops_alert_stuck_dispatch_age_s=900.0),
        stuck_dispatches=[_stuck(age_s=500)],
        metrics=_metrics(),
    )
    assert "stuck_dispatch" not in {c.kind for c in conds}


def test_evaluate_flags_outbox_dead_letter() -> None:
    conds = scheduler.evaluate_alert_conditions(
        _settings(), stuck_dispatches=[], metrics=_metrics(dead=2, failed=1)
    )
    dl = next(c for c in conds if c.kind == "outbox_dead_letter")
    assert "3" in dl.summary  # dead + failed


def test_evaluate_flags_outbox_backlog() -> None:
    conds = scheduler.evaluate_alert_conditions(
        _settings(ops_alert_outbox_depth_threshold=100),
        stuck_dispatches=[],
        metrics=_metrics(depth=150),
    )
    assert "outbox_backlog" in {c.kind for c in conds}


def test_evaluate_flags_open_breaker() -> None:
    conds = scheduler.evaluate_alert_conditions(
        _settings(),
        stuck_dispatches=[],
        metrics=_metrics(breakers={"services.leadconnectorhq.com": "open"}),
    )
    bo = next(c for c in conds if c.kind == "breaker_open")
    assert "leadconnectorhq" in bo.detail


def test_evaluate_ignores_closed_breaker() -> None:
    conds = scheduler.evaluate_alert_conditions(
        _settings(),
        stuck_dispatches=[],
        metrics=_metrics(breakers={"host": "closed"}),
    )
    assert "breaker_open" not in {c.kind for c in conds}


def test_evaluate_flags_cost_over_cap() -> None:
    conds = scheduler.evaluate_alert_conditions(
        _settings(), stuck_dispatches=[], metrics=_metrics(over_cap=True)
    )
    assert "cost_over_cap" in {c.kind for c in conds}


def test_evaluate_healthy_is_empty() -> None:
    conds = scheduler.evaluate_alert_conditions(
        _settings(), stuck_dispatches=[], metrics=_metrics()
    )
    assert conds == []


# ---------------------------------------------------------------------------
# deliver_ops_alerts (delivery + throttle)
# ---------------------------------------------------------------------------


def test_deliver_fires_on_problem(
    slack_env: None, capture_slack: dict[str, Any]
) -> None:
    s = _settings()
    conds = [scheduler.AlertCondition("stuck_dispatch", "critical", "wedged", "detail")]
    sent = asyncio.run(scheduler.deliver_ops_alerts(s, conds))
    assert sent == 1
    assert len(capture_slack["calls"]) == 1
    call = capture_slack["calls"][0]
    assert call["channel"] == "C-OPS-1"
    assert call["token"] == "xoxb-test"
    # The blocks carry a header + one section per condition.
    types = [b["type"] for b in call["blocks"]]
    assert types[0] == "header"
    assert "section" in types


def test_deliver_no_alert_when_healthy(
    slack_env: None, capture_slack: dict[str, Any]
) -> None:
    sent = asyncio.run(scheduler.deliver_ops_alerts(_settings(), []))
    assert sent == 0
    assert capture_slack["calls"] == []


def test_deliver_throttles_repeat_within_window(
    slack_env: None, capture_slack: dict[str, Any]
) -> None:
    """Same kind on consecutive ticks pages once, then is suppressed."""
    s = _settings(ops_alert_throttle_s=3600.0)
    conds = [scheduler.AlertCondition("stuck_dispatch", "critical", "wedged", "d")]
    first = asyncio.run(scheduler.deliver_ops_alerts(s, conds))
    second = asyncio.run(scheduler.deliver_ops_alerts(s, conds))
    assert first == 1
    assert second == 0  # throttled
    assert len(capture_slack["calls"]) == 1


def test_deliver_rearms_after_return_to_healthy(
    slack_env: None, capture_slack: dict[str, Any]
) -> None:
    """A recover-then-rebreak pages a fresh alert (throttle re-armed)."""
    s = _settings(ops_alert_throttle_s=3600.0)
    conds = [scheduler.AlertCondition("stuck_dispatch", "critical", "wedged", "d")]
    asyncio.run(scheduler.deliver_ops_alerts(s, conds))  # pages
    asyncio.run(scheduler.deliver_ops_alerts(s, []))  # healthy -> re-arm
    second = asyncio.run(scheduler.deliver_ops_alerts(s, conds))  # breaks again
    assert second == 1
    assert len(capture_slack["calls"]) == 2


def test_deliver_distinct_kinds_each_page(
    slack_env: None, capture_slack: dict[str, Any]
) -> None:
    """Two different kinds firing on the same tick are batched into one post."""
    s = _settings()
    conds = [
        scheduler.AlertCondition("stuck_dispatch", "critical", "a", "a"),
        scheduler.AlertCondition("outbox_dead_letter", "critical", "b", "b"),
    ]
    sent = asyncio.run(scheduler.deliver_ops_alerts(s, conds))
    assert sent == 2
    assert len(capture_slack["calls"]) == 1  # batched
    sections = [b for b in capture_slack["calls"][0]["blocks"] if b["type"] == "section"]
    assert len(sections) == 2


def test_deliver_skips_when_no_channel(
    capture_slack: dict[str, Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    """No ops channel configured -> logged skip, no post, no raise."""
    monkeypatch.setenv("SLACK_BOT_TOKEN", "xoxb-test")
    monkeypatch.delenv("SLACK_OPS_CHANNEL_ID", raising=False)
    conds = [scheduler.AlertCondition("stuck_dispatch", "critical", "a", "a")]
    sent = asyncio.run(scheduler.deliver_ops_alerts(_settings(), conds))
    assert sent == 0
    assert capture_slack["calls"] == []


def test_deliver_skips_when_no_token(
    capture_slack: dict[str, Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("SLACK_BOT_TOKEN", raising=False)
    monkeypatch.setenv("SLACK_OPS_CHANNEL_ID", "C-OPS-1")
    conds = [scheduler.AlertCondition("stuck_dispatch", "critical", "a", "a")]
    sent = asyncio.run(scheduler.deliver_ops_alerts(_settings(), conds))
    assert sent == 0
    assert capture_slack["calls"] == []


def test_deliver_never_raises_on_slack_exception(
    slack_env: None, capture_slack: dict[str, Any]
) -> None:
    """An exception out of the Slack sender is caught -> no raise, returns 0."""
    capture_slack["raise"] = RuntimeError("slack down")
    conds = [scheduler.AlertCondition("stuck_dispatch", "critical", "a", "a")]
    # Must not raise.
    sent = asyncio.run(scheduler.deliver_ops_alerts(_settings(), conds))
    assert sent == 0


def test_deliver_handles_slack_logical_failure(
    slack_env: None, capture_slack: dict[str, Any]
) -> None:
    """Slack returns ok=False (sender returns False) -> no raise, still attempted."""
    capture_slack["ok"] = False
    conds = [scheduler.AlertCondition("stuck_dispatch", "critical", "a", "a")]
    sent = asyncio.run(scheduler.deliver_ops_alerts(_settings(), conds))
    # The condition was consumed by the throttle + attempted; ok=False just logs.
    assert sent == 1
    assert len(capture_slack["calls"]) == 1


# ---------------------------------------------------------------------------
# run_observability_once end-to-end wiring
# ---------------------------------------------------------------------------


@pytest.fixture
def _patch_sb(monkeypatch: pytest.MonkeyPatch) -> FakeSupabase:
    sb = FakeSupabase()
    monkeypatch.setattr("src.supabase_client.get_supabase_admin", lambda: sb)
    return sb


async def test_observability_tick_delivers_alert_on_dead_letters(
    _patch_sb: FakeSupabase,
    slack_env: None,
    capture_slack: dict[str, Any],
) -> None:
    """A dead-lettered outbox row makes the observability tick page the channel."""
    sb = _patch_sb
    sb.seed("_legacy_integration_outbox", [{"status": "dead"}, {"status": "dead"}])
    result = await scheduler.run_observability_once(_settings())
    # The tick still returns its stuck counts...
    assert result == {"stuck_dispatches": 0, "stuck_outbox": 0}
    # ...and it delivered an ops alert for the dead-letter pile.
    assert len(capture_slack["calls"]) == 1
    assert "dead-letter" in capture_slack["calls"][0]["text"]


async def test_observability_tick_no_alert_when_healthy(
    _patch_sb: FakeSupabase,
    slack_env: None,
    capture_slack: dict[str, Any],
) -> None:
    """No problems -> the tick runs clean and pages nothing."""
    result = await scheduler.run_observability_once(_settings())
    assert result == {"stuck_dispatches": 0, "stuck_outbox": 0}
    assert capture_slack["calls"] == []


async def test_observability_tick_never_raises_on_alert_failure(
    _patch_sb: FakeSupabase,
    slack_env: None,
    capture_slack: dict[str, Any],
) -> None:
    """A Slack blow-up inside the tick is swallowed -- the tick still completes."""
    sb = _patch_sb
    sb.seed("_legacy_integration_outbox", [{"status": "dead"}])
    capture_slack["raise"] = RuntimeError("boom")
    # Must complete normally and return the stuck counts.
    result = await scheduler.run_observability_once(_settings())
    assert result == {"stuck_dispatches": 0, "stuck_outbox": 0}
