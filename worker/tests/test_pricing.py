"""Unit tests for the worker pricing source of truth (E4.2 / #501).

The worker's ``PRICING`` mirrors ``lib/pricing.ts`` so the dashboard estimate and
the recorded cost reconcile. These pin the per-unit figures + the helper math so
a vendor price edit can't silently drift one side from the other.
"""

from __future__ import annotations

import pytest

from src.services import pricing


def test_pricing_mirrors_ts_values() -> None:
    # Must match the values in lib/pricing.ts exactly (asserted there too).
    assert pricing.PRICING["kie_ai"]["per_image"] == pytest.approx(0.05)
    assert pricing.PRICING["kie_video"]["per_clip"] == pytest.approx(0.40)
    assert pricing.PRICING["elevenlabs"]["per_1k_chars"] == pytest.approx(0.30)
    assert pricing.PRICING["submagic"]["per_video"] == pytest.approx(1.0)
    assert pricing.PRICING["anthropic"]["per_million_input"] == pytest.approx(3.0)
    assert pricing.PRICING["anthropic"]["per_million_output"] == pytest.approx(15.0)
    assert pricing.PRICING["hyperframes"]["per_video"] == 0.0
    assert pricing.PRICING["yt_dlp"]["per_clip"] == 0.0


def test_image_cost_helpers() -> None:
    assert pricing.kie_image_cost(1) == pytest.approx(0.05)
    assert pricing.kie_image_cost(4) == pytest.approx(0.20)
    # Codex (subscription) renders are always free.
    assert pricing.codex_image_cost(1) == 0.0
    assert pricing.codex_image_cost(10) == 0.0


def test_video_cost_helpers() -> None:
    assert pricing.kie_video_cost(1) == pytest.approx(0.40)
    assert pricing.kie_video_cost(3) == pytest.approx(1.20)


def test_tts_cost_helper() -> None:
    # 1,000 chars == one per-1k unit.
    assert pricing.tts_cost(1000) == pytest.approx(0.30)
    assert pricing.tts_cost(500) == pytest.approx(0.15)
    assert pricing.tts_cost(0) == 0.0


def test_default_per_ad_budget_derives_from_per_clip_price() -> None:
    # The default cap is a multiple of the per-clip price, so it never drifts
    # from PRICING. (12.5 clips x $0.40 == $5.00, the prior hardcoded ceiling.)
    assert pricing.DEFAULT_PER_AD_BUDGET_USD == pytest.approx(5.0)
    assert pricing.DEFAULT_PER_AD_BUDGET_USD == pytest.approx(
        pricing.DEFAULT_PER_AD_BUDGET_CLIPS * pricing.PRICING["kie_video"]["per_clip"]
    )
