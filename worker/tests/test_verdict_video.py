"""Tests for the video-creative verdict computation.

The video pass inherits every image rule (covered in `test_verdict.py`) and
layers four video-specific signals on top. Here we focus on:

* Image rules still fire on video inputs.
* Video-specific kills/watches behave per spec.
* Image kill > video kill > video watch > image watch > keep precedence.
"""

from __future__ import annotations

import pytest

from src.services.verdict_video import (
    HIGH_DROP_OFF_3S,
    HOOK_KILL_SPEND_FLOOR,
    LOW_HOOK_RATE,
    LOW_WATCH_TIME_P50_S,
    VideoPerfInput,
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
    hook_rate: float = 0.50,
    drop_off_3s: float = 0.30,
    view_rate_avg: float = 0.55,
    watch_time_p50: float = 12.0,
) -> VideoPerfInput:
    return VideoPerfInput(
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
        hook_rate=hook_rate,
        drop_off_3s=drop_off_3s,
        view_rate_avg=view_rate_avg,
        watch_time_p50=watch_time_p50,
    )


# ---------------------------------------------------------------------------
# Image rules still apply
# ---------------------------------------------------------------------------


def test_grace_period_overrides_everything_on_video() -> None:
    """48h grace beats even a 5% hook rate + zero leads."""
    p = _input(
        spend=200.0,
        leads_meta=0,
        leads_ghl=0,
        hook_rate=0.05,
        days_since_launch=0,
    )
    verdict, reason = compute_verdict(p)
    assert verdict == "keep"
    assert "grace" in reason.lower()


def test_image_rule_kill_propagates_to_video() -> None:
    """$75+ zero leads kills regardless of video-side health."""
    p = _input(
        spend=100.0,
        leads_meta=0,
        leads_ghl=0,
        hook_rate=0.60,  # healthy
        drop_off_3s=0.20,
        watch_time_p50=20.0,
    )
    verdict, reason = compute_verdict(p)
    assert verdict == "kill"
    assert "zero leads" in reason


def test_image_creative_fatigue_kill_propagates() -> None:
    """freq > 3 + CTR < 1% kills via the image rule, not the video rule."""
    p = _input(
        spend=50.0,
        freq=4.0,
        ctr=0.005,
        hook_rate=0.60,
        leads_meta=1,
    )
    verdict, reason = compute_verdict(p)
    assert verdict == "kill"
    assert "fatigue" in reason.lower()


# ---------------------------------------------------------------------------
# Video-specific kill
# ---------------------------------------------------------------------------


def test_kill_on_low_hook_rate_with_high_spend() -> None:
    """hook_rate < 20% with spend >= $75 → kill."""
    p = _input(
        spend=100.0,
        leads_meta=2,  # not a spend+no-leads kill
        leads_ghl=0,
        hook_rate=0.10,
        ctr=0.025,  # healthy CTR
        freq=2.0,  # healthy freq
    )
    verdict, reason = compute_verdict(p)
    assert verdict == "kill"
    assert "hook" in reason.lower()
    assert "10.0%" in reason


def test_no_kill_on_low_hook_rate_when_spend_below_floor() -> None:
    """A weak hook with only $50 spent is watch, not kill (not enough data)."""
    p = _input(
        spend=50.0,
        leads_meta=2,
        hook_rate=0.10,
        ctr=0.025,
        freq=2.0,
    )
    verdict, reason = compute_verdict(p)
    assert verdict == "watch"
    assert "hook" in reason.lower()


def test_kill_on_high_drop_off_with_high_spend() -> None:
    """drop_off_3s > 80% AND spend >= $75 escalates to kill."""
    p = _input(
        spend=100.0,
        leads_meta=2,
        hook_rate=0.40,  # healthy
        drop_off_3s=0.90,
        ctr=0.025,
        freq=2.0,
    )
    verdict, reason = compute_verdict(p)
    assert verdict == "kill"
    assert "drop-off" in reason.lower()


# ---------------------------------------------------------------------------
# Video-specific watch
# ---------------------------------------------------------------------------


def test_watch_on_high_drop_off_low_spend() -> None:
    """drop_off_3s > 80% with low spend → watch, not kill."""
    p = _input(
        spend=20.0,
        leads_meta=2,
        hook_rate=0.40,
        drop_off_3s=0.90,
        ctr=0.025,
        freq=2.0,
    )
    verdict, reason = compute_verdict(p)
    assert verdict == "watch"
    assert "drop-off" in reason.lower()


def test_watch_on_low_watch_time() -> None:
    """watch_time_p50 < 5s → watch."""
    p = _input(
        spend=30.0,
        leads_meta=2,
        hook_rate=0.40,
        drop_off_3s=0.30,
        watch_time_p50=3.0,
        ctr=0.025,
        freq=2.0,
    )
    verdict, reason = compute_verdict(p)
    assert verdict == "watch"
    assert "watch time" in reason.lower()


def test_watch_on_low_hook_alone_low_spend() -> None:
    p = _input(
        spend=30.0,
        leads_meta=2,
        hook_rate=0.10,
        drop_off_3s=0.30,
        watch_time_p50=10.0,
        ctr=0.025,
        freq=2.0,
    )
    verdict, reason = compute_verdict(p)
    assert verdict == "watch"
    assert "hook" in reason.lower()


# ---------------------------------------------------------------------------
# Keep paths
# ---------------------------------------------------------------------------


def test_keep_when_all_signals_healthy() -> None:
    """Solid video: 50% hook, 30% drop, 12s p50 watch, 5% CTR, freq 1.5."""
    p = _input(
        spend=30.0,
        leads_meta=5,
        hook_rate=0.50,
        drop_off_3s=0.30,
        watch_time_p50=12.0,
        ctr=0.05,
        freq=1.5,
    )
    verdict, reason = compute_verdict(p)
    assert verdict == "keep"
    assert "strong" in reason.lower() or "within" in reason.lower()


# ---------------------------------------------------------------------------
# Precedence: image-kill must win over video-watch
# ---------------------------------------------------------------------------


def test_image_kill_wins_over_video_signals() -> None:
    """A row with both an image-kill signal and a video-watch signal returns
    the image kill (stronger evidence)."""
    p = _input(
        spend=200.0,
        leads_meta=0,
        leads_ghl=0,
        hook_rate=0.10,  # would be a kill on its own
        drop_off_3s=0.90,
    )
    verdict, reason = compute_verdict(p)
    assert verdict == "kill"
    # The image rule's reason should surface, not the hook-rate text.
    assert "zero leads" in reason


# ---------------------------------------------------------------------------
# Threshold pinning
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "constant,expected",
    [
        (LOW_HOOK_RATE, 0.20),
        (HOOK_KILL_SPEND_FLOOR, 75.0),
        (HIGH_DROP_OFF_3S, 0.80),
        (LOW_WATCH_TIME_P50_S, 5.0),
    ],
)
def test_video_thresholds_match_spec(constant: float, expected: float) -> None:
    assert constant == expected
