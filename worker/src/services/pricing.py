"""Single pricing source of truth for the worker (E4.2 / #501).

The pipeline spends money in two languages: the TypeScript estimator
(``lib/pricing.ts`` → ``lib/cost-estimator.ts``) forecasts cost on the
dashboard, and the Python worker records ACTUAL cost as each paid call
resolves. Those two used to drift across four hardcoded literals:

  * ``lib/pricing.ts``   kie_ai.per_image
  * ``pipeline_tools.py`` _CONCEPT_PREVIEW.cost_usd / _FINAL.cost_usd
  * ``routes/video.py``  EST_COST_PER_GENERATED_CLIP_USD / DEFAULT_PER_AD_BUDGET_USD

This module is the worker's half of the single source of truth. It mirrors the
``PRICING`` object in ``lib/pricing.ts`` exactly (same vendors, same per-unit
USD figures), so the estimate the manager sees on the dashboard and the cost the
worker records reconcile. Keep the two in lockstep: a vendor price change edits
``PRICING`` HERE and ``PRICING`` in ``lib/pricing.ts`` together (the values are
asserted equal by ``lib/pricing.test.ts`` and ``test_pricing.py``).

Effective-dating note (E4.2 follow-up): pricing is a flat snapshot today. When
vendor pricing churns often enough to need history, promote ``PRICING`` to an
effective-dated lookup (``[(effective_from, table), ...]`` selected by render
time); every consumer here already reads through the helpers below, so that
change stays local to this module.
"""

from __future__ import annotations


# Vendor per-unit USD pricing. Mirrors ``PRICING`` in ``lib/pricing.ts`` — keep
# the two identical (asserted by the test suites on both sides).
PRICING: dict[str, dict[str, float]] = {
    # Kie.ai image generation, billed per output image (per ratio).
    "kie_ai": {"per_image": 0.05},
    # Kie video generation (Veo Fast tier), billed per generated clip.
    "kie_video": {"per_clip": 0.40},
    # ElevenLabs TTS (via Kie), billed per 1,000 characters of script.
    "elevenlabs": {"per_1k_chars": 0.30},
    # Submagic clip post-processing, billed per finished video.
    "submagic": {"per_video": 1.0},
    # Anthropic Claude pricing per million tokens (Sonnet 4.x tier).
    "anthropic": {"per_million_input": 3.0, "per_million_output": 15.0},
    # Hyperframes — currently bundled, zero marginal cost per video.
    "hyperframes": {"per_video": 0.0},
    # yt-dlp clip download — local, zero marginal cost.
    "yt_dlp": {"per_clip": 0.0},
    # ffmpeg compose / Whisper caption — run in-container, zero marginal cost.
    "local": {"per_op": 0.0},
    # Subscription-backed codex (gpt-image-2) render — $0 marginal (manager's
    # ChatGPT/Codex OAuth pays nothing per image).
    "codex": {"per_image": 0.0},
}


# ---------------------------------------------------------------------------
# Image generation
# ---------------------------------------------------------------------------


def kie_image_cost(units: float = 1.0) -> float:
    """USD cost of ``units`` Kie.ai image renders (1 unit == 1 ratio output)."""
    return round(units * PRICING["kie_ai"]["per_image"], 6)


def codex_image_cost(units: float = 1.0) -> float:
    """USD cost of a subscription-backed codex render — always 0 (free)."""
    return round(units * PRICING["codex"]["per_image"], 6)


# ---------------------------------------------------------------------------
# Video generation + TTS
# ---------------------------------------------------------------------------


def kie_video_cost(clips: float = 1.0) -> float:
    """USD cost of generating ``clips`` Kie video clips."""
    return round(clips * PRICING["kie_video"]["per_clip"], 6)


def tts_cost(chars: float) -> float:
    """USD cost of synthesising ``chars`` characters of TTS voiceover."""
    return round((chars / 1000.0) * PRICING["elevenlabs"]["per_1k_chars"], 6)


# ---------------------------------------------------------------------------
# Per-ad video budget (the worker-side hard cap, E4.4 follow-up wiring)
# ---------------------------------------------------------------------------

# Default per-ad spend ceiling the worker enforces before any Kie generation
# submit. Derived from the per-clip price so it never drifts from PRICING: ten
# generated clips' worth of headroom for the default Veo Fast tier.
DEFAULT_PER_AD_BUDGET_CLIPS = 12.5
DEFAULT_PER_AD_BUDGET_USD = round(
    DEFAULT_PER_AD_BUDGET_CLIPS * PRICING["kie_video"]["per_clip"], 6
)
