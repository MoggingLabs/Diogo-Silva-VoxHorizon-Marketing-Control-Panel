"""Tests for the image-creative verdict computation."""

from __future__ import annotations

import pytest

from src.services.verdict import (
    GRACE_PERIOD_DAYS,
    HIGH_FREQUENCY,
    KILL_CPL_MULTIPLIER,
    KILL_SPEND_WITHOUT_LEADS,
    LOW_CTR,
    STRONG_CTR,
    ImagePerfInput,
    compute_verdict,
)


def _input(
    *,
    spend: float = 0.0,
    impressions: int = 1000,
    clicks: int = 50,
    ctr: float = 0.05,
    leads_meta: int = 5,
    leads_ghl: int = 0,
    cpl_real: float | None = 10.0,
    freq: float = 1.5,
    cpl_target: float | None = 20.0,
    days_since_launch: int = 7,
) -> ImagePerfInput:
    """Build an ImagePerfInput with sane defaults (healthy campaign).

    Tests override only the fields that matter for the rule under test.
    """
    return ImagePerfInput(
        spend=spend,
        impressions=impressions,
        clicks=clicks,
        ctr=ctr,
        leads_meta=leads_meta,
        leads_ghl=leads_ghl,
        cpl_real=cpl_real,
        freq=freq,
        cpl_target=cpl_target,
        days_since_launch=days_since_launch,
    )


# ---------------------------------------------------------------------------
# Grace period
# ---------------------------------------------------------------------------


def test_grace_period_returns_keep_even_with_terrible_metrics() -> None:
    """A brand-new ad with zero leads + $100 spend stays at keep for 48h."""
    p = _input(
        spend=100.0,
        leads_meta=0,
        leads_ghl=0,
        ctr=0.001,
        freq=10.0,
        days_since_launch=1,
    )
    verdict, reason = compute_verdict(p)
    assert verdict == "keep"
    assert "grace" in reason.lower()


def test_grace_period_boundary_is_inclusive_at_day_2() -> None:
    """At day 2 the grace period ends — kill rules should fire."""
    p = _input(
        spend=100.0,
        leads_meta=0,
        leads_ghl=0,
        days_since_launch=GRACE_PERIOD_DAYS,
    )
    verdict, _ = compute_verdict(p)
    assert verdict == "kill"


# ---------------------------------------------------------------------------
# Kill rules
# ---------------------------------------------------------------------------


def test_kill_when_spend_over_75_with_zero_leads() -> None:
    p = _input(spend=80.0, leads_meta=0, leads_ghl=0)
    verdict, reason = compute_verdict(p)
    assert verdict == "kill"
    assert "$80" in reason
    assert "zero leads" in reason


def test_no_kill_at_spend_75_with_at_least_one_lead() -> None:
    """The kill rule requires *zero* leads; one lead saves the day."""
    p = _input(spend=200.0, leads_meta=0, leads_ghl=1, ctr=0.05, freq=1.5)
    verdict, _ = compute_verdict(p)
    assert verdict == "keep"


def test_kill_at_exact_spend_threshold() -> None:
    """Exactly $75 with zero leads should trigger (>=, not >)."""
    p = _input(spend=KILL_SPEND_WITHOUT_LEADS, leads_meta=0, leads_ghl=0)
    verdict, _ = compute_verdict(p)
    assert verdict == "kill"


def test_kill_when_cpl_over_1_5x_target_zero_leads() -> None:
    """CPL > 1.5× target with zero leads → kill (cheaper spend, but
    still wasting money). Spend is kept below the $75 floor so the
    CPL rule is the one firing."""
    p = _input(
        spend=50.0,
        cpl_real=50.0,  # 2.5x of $20 target
        cpl_target=20.0,
        leads_meta=0,
        leads_ghl=0,
    )
    verdict, reason = compute_verdict(p)
    assert verdict == "kill"
    assert "CPL" in reason
    assert "$50.00" in reason
    assert f"{KILL_CPL_MULTIPLIER:.1f}x" in reason


def test_no_kill_when_cpl_over_target_but_leads_present() -> None:
    """Bad CPL with at least one lead doesn't kill (could still be early)."""
    p = _input(
        spend=40.0,
        cpl_real=50.0,
        cpl_target=20.0,
        leads_meta=1,
        leads_ghl=0,
    )
    verdict, _ = compute_verdict(p)
    # CTR is healthy in the default, freq is fine → keep.
    assert verdict == "keep"


def test_cpl_rule_skipped_when_target_missing() -> None:
    """Without a per-client CPL target, the multiplier rule is a no-op.

    Spend is kept under $75 so the spend-rule doesn't fire either.
    """
    p = _input(
        spend=40.0,
        cpl_real=500.0,
        cpl_target=None,
        leads_meta=0,
        leads_ghl=0,
    )
    verdict, _ = compute_verdict(p)
    assert verdict == "keep"


def test_kill_on_creative_fatigue_freq_high_and_ctr_low() -> None:
    """freq > 3 with CTR < 1% → creative fatigue → kill."""
    p = _input(
        spend=50.0,
        freq=4.0,
        ctr=0.005,
        leads_meta=1,
        leads_ghl=0,
    )
    verdict, reason = compute_verdict(p)
    assert verdict == "kill"
    assert "fatigue" in reason.lower()


# ---------------------------------------------------------------------------
# Watch rules
# ---------------------------------------------------------------------------


def test_watch_on_low_ctr_alone() -> None:
    """CTR < 1% with healthy freq → watch."""
    p = _input(spend=20.0, ctr=0.005, freq=1.5, leads_meta=2, leads_ghl=0)
    verdict, reason = compute_verdict(p)
    assert verdict == "watch"
    assert "low CTR" in reason


def test_watch_on_high_freq_alone() -> None:
    """freq > 3 with healthy CTR → watch (no fatigue kill yet)."""
    p = _input(spend=20.0, ctr=0.025, freq=4.0, leads_meta=2, leads_ghl=0)
    verdict, reason = compute_verdict(p)
    assert verdict == "watch"
    assert "high frequency" in reason.lower()


# ---------------------------------------------------------------------------
# Keep rules
# ---------------------------------------------------------------------------


def test_keep_strong_when_ctr_over_2_percent() -> None:
    p = _input(spend=20.0, ctr=0.05, freq=2.0)
    verdict, reason = compute_verdict(p)
    assert verdict == "keep"
    assert "strong" in reason.lower()


def test_keep_happy_path_within_thresholds() -> None:
    """CTR between 1% and 2%, normal freq → keep / within thresholds."""
    p = _input(spend=20.0, ctr=0.015, freq=1.5)
    verdict, reason = compute_verdict(p)
    assert verdict == "keep"
    assert "within thresholds" in reason


# ---------------------------------------------------------------------------
# Threshold sanity
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "constant,expected",
    [
        (GRACE_PERIOD_DAYS, 2),
        (KILL_SPEND_WITHOUT_LEADS, 75.0),
        (KILL_CPL_MULTIPLIER, 1.5),
        (HIGH_FREQUENCY, 3.0),
        (LOW_CTR, 0.01),
        (STRONG_CTR, 0.02),
    ],
)
def test_threshold_constants_match_spec(constant: float, expected: float) -> None:
    """Pins the Wave 4 spec thresholds so unintentional tweaks are caught."""
    assert constant == expected
