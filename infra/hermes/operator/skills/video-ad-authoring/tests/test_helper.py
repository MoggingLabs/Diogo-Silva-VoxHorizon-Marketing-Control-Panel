"""Unit tests for the ``video-ad-authoring`` helper.

Pure functions, nothing to mock. Mirrors the ``image-ad-authoring`` test layout
(sys.path insert + ``from helper import ...``). We exercise brief assembly, angle
normalization, voiceover linting (word budget + banned AI-tell words), segment +
script assembly (count/contiguity/duration bounds), concept assembly, and the
distinctness guard.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

# The helper lives one level up from this tests/ directory.
HELPER_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(HELPER_DIR))

from helper import (  # noqa: E402
    ANGLES,
    BANNED_VOICEOVER_WORDS,
    BROLL_INTENTS,
    HOOK_STYLES,
    MAX_VOICEOVER_WORDS,
    VideoAdAuthoringError,
    assert_distinct_concepts,
    build_script,
    build_segment,
    build_video_brief,
    build_video_concept,
    normalize_angles,
    validate_voiceover_text,
)


def _seg(idx: int = 0, **over: object) -> dict:
    base = dict(
        idx=idx,
        topic="roof inspection",
        duration_s=6,
        voiceover_text="We checked the roof and found three loose shingles.",
        voiceover_direction="calm, reassuring",
        broll_query="roofer inspecting shingles close up",
        broll_intent="demonstrate",
        captions_emphasis=["three", "loose"],
    )
    base.update(over)
    return build_segment(**base)  # type: ignore[arg-type]


# ---------------------------------------------------------------------------
# build_video_brief
# ---------------------------------------------------------------------------


def test_build_brief_minimal() -> None:
    brief = build_video_brief(
        market="Austin TX roofing",
        offer_text="$99 roof inspection",
        angles=["before_after", "urgency"],
        target_duration_s=24,
        voice_id="voice-123",
    )
    assert brief["market"] == "Austin TX roofing"
    assert brief["angles"] == ["before_after", "urgency"]
    assert brief["target_duration_s"] == 24
    assert brief["voice_id"] == "voice-123"
    assert brief["dimensions"] == "9x16"
    assert brief["broll_selection_mode"] == "auto"


def test_build_brief_optional_and_extras() -> None:
    brief = build_video_brief(
        market="m",
        offer_text="o",
        angles=["savings"],
        target_duration_s=20,
        voice_id="v",
        hook_style="question",
        music=True,
        captions_style="bold_yellow",
        service_type="roofing",
        audience="homeowners 35-65",
        extras={"budget": 500},
    )
    assert brief["hook_style"] == "question"
    assert brief["music"] is True
    assert brief["captions_style"] == "bold_yellow"
    assert brief["service_type"] == "roofing"
    assert brief["budget"] == 500


def test_build_brief_extras_cannot_clobber() -> None:
    with pytest.raises(VideoAdAuthoringError, match="override required brief keys"):
        build_video_brief(
            market="m",
            offer_text="o",
            angles=["savings"],
            target_duration_s=20,
            voice_id="v",
            extras={"voice_id": "evil"},
        )


def test_build_brief_rejects_bad_duration() -> None:
    with pytest.raises(VideoAdAuthoringError, match="target_duration_s"):
        build_video_brief(
            market="m", offer_text="o", angles=["savings"],
            target_duration_s=500, voice_id="v",
        )


def test_build_brief_requires_voice_id() -> None:
    with pytest.raises(VideoAdAuthoringError, match="voice_id"):
        build_video_brief(
            market="m", offer_text="o", angles=["savings"],
            target_duration_s=20, voice_id="",
        )


def test_build_brief_rejects_bad_mode_and_hook_and_dims() -> None:
    with pytest.raises(VideoAdAuthoringError, match="broll_selection_mode"):
        build_video_brief(market="m", offer_text="o", angles=["savings"],
                          target_duration_s=20, voice_id="v",
                          broll_selection_mode="whatever")
    with pytest.raises(VideoAdAuthoringError, match="hook_style"):
        build_video_brief(market="m", offer_text="o", angles=["savings"],
                          target_duration_s=20, voice_id="v", hook_style="nope")
    with pytest.raises(VideoAdAuthoringError, match="dimensions"):
        build_video_brief(market="m", offer_text="o", angles=["savings"],
                          target_duration_s=20, voice_id="v", dimensions="4x5")


# ---------------------------------------------------------------------------
# normalize_angles
# ---------------------------------------------------------------------------


def test_normalize_angles_ok_and_order() -> None:
    assert normalize_angles(["urgency", "savings"]) == ["urgency", "savings"]


def test_normalize_angles_errors() -> None:
    with pytest.raises(VideoAdAuthoringError, match="non-empty list"):
        normalize_angles([])
    with pytest.raises(VideoAdAuthoringError, match="unknown angle"):
        normalize_angles(["nope"])
    with pytest.raises(VideoAdAuthoringError, match="duplicate angle"):
        normalize_angles(["savings", "savings"])


def test_all_angles_have_descriptions() -> None:
    assert all(isinstance(v, str) and v for v in ANGLES.values())


# ---------------------------------------------------------------------------
# validate_voiceover_text
# ---------------------------------------------------------------------------


def test_validate_voiceover_ok() -> None:
    assert validate_voiceover_text("  Plain spoken line.  ") == "Plain spoken line."


def test_validate_voiceover_too_long() -> None:
    with pytest.raises(VideoAdAuthoringError, match="words"):
        validate_voiceover_text(" ".join(["word"] * (MAX_VOICEOVER_WORDS + 1)))


def test_validate_voiceover_banned_words() -> None:
    assert "unleash" in BANNED_VOICEOVER_WORDS
    with pytest.raises(VideoAdAuthoringError, match="AI-tell words"):
        validate_voiceover_text("We unleash the best roofing in town")


# ---------------------------------------------------------------------------
# build_segment
# ---------------------------------------------------------------------------


def test_build_segment_shape() -> None:
    seg = _seg(idx=2)
    assert seg["idx"] == 2
    assert seg["broll_intent"] == "demonstrate"
    assert seg["captions_emphasis"] == ["three", "loose"]
    assert set(seg) == {
        "idx", "topic", "duration_s", "voiceover_text", "voiceover_direction",
        "broll_query", "broll_intent", "captions_emphasis",
    }


def test_build_segment_bad_idx() -> None:
    with pytest.raises(VideoAdAuthoringError, match="idx"):
        _seg(idx=-1)
    with pytest.raises(VideoAdAuthoringError, match="idx"):
        _seg(idx=True)  # bool is not a valid int idx


def test_build_segment_bad_duration_and_intent() -> None:
    with pytest.raises(VideoAdAuthoringError, match="duration_s"):
        _seg(duration_s=99)
    with pytest.raises(VideoAdAuthoringError, match="broll_intent"):
        _seg(broll_intent="zoom")


def test_build_segment_bad_emphasis() -> None:
    with pytest.raises(VideoAdAuthoringError, match="captions_emphasis"):
        _seg(captions_emphasis=["ok", ""])


def test_build_segment_propagates_banned_vo() -> None:
    with pytest.raises(VideoAdAuthoringError, match="AI-tell"):
        _seg(voiceover_text="We elevate your home")


def test_broll_intents_populated() -> None:
    assert "demonstrate" in BROLL_INTENTS and "establish" in BROLL_INTENTS


# ---------------------------------------------------------------------------
# build_script
# ---------------------------------------------------------------------------


def test_build_script_ok_computes_total() -> None:
    script = build_script(
        hook="Is your roof one storm from a leak?",
        segments=[_seg(0, duration_s=6), _seg(1, duration_s=8)],
        outro="Book your $99 inspection today.",
        target_duration_s=14,
    )
    assert script["total_duration_s"] == 14
    assert script["hook"].startswith("Is your roof")
    assert len(script["segments"]) == 2


def test_build_script_segment_count_bounds() -> None:
    with pytest.raises(VideoAdAuthoringError, match="1-4 entries"):
        build_script(hook="h", segments=[], outro="o")
    too_many = [_seg(i, duration_s=4) for i in range(5)]
    with pytest.raises(VideoAdAuthoringError, match="1-4 entries"):
        build_script(hook="h", segments=too_many, outro="o")


def test_build_script_idx_must_be_contiguous() -> None:
    with pytest.raises(VideoAdAuthoringError, match="0-contiguous"):
        build_script(
            hook="h",
            segments=[_seg(0, duration_s=5), _seg(2, duration_s=5)],
            outro="o",
        )


def test_build_script_total_duration_bounds() -> None:
    # A single short segment sums below MIN_TOTAL_DURATION_S (the reachable
    # bound; the 90s ceiling is unreachable since 4 segments x 20s = 80s max).
    with pytest.raises(VideoAdAuthoringError, match="outside"):
        build_script(hook="h", segments=[_seg(0, duration_s=4)], outro="o")


def test_build_script_target_tolerance() -> None:
    with pytest.raises(VideoAdAuthoringError, match="tolerance"):
        build_script(
            hook="h",
            segments=[_seg(0, duration_s=6), _seg(1, duration_s=6)],
            outro="o",
            target_duration_s=30,
        )


# ---------------------------------------------------------------------------
# build_video_concept + assert_distinct_concepts
# ---------------------------------------------------------------------------


def _concept(angle: str, hook: str, label: str = "v1") -> dict:
    return build_video_concept(
        angle=angle,
        concept_label=label,
        hook=hook,
        segments=[_seg(0, duration_s=6), _seg(1, duration_s=8)],
        outro="Book today.",
    )


def test_build_video_concept_shape() -> None:
    c = _concept("urgency", "Storm season is here.")
    assert c["concept"] == "urgency__v1"
    assert c["angle"] == "urgency"
    assert c["script"]["total_duration_s"] == 14


def test_build_video_concept_unknown_angle() -> None:
    with pytest.raises(VideoAdAuthoringError, match="unknown angle"):
        _concept("nope", "hook")


def test_assert_distinct_concepts_ok() -> None:
    assert_distinct_concepts([
        _concept("urgency", "Storm season is here."),
        _concept("savings", "Save $200 this month."),
    ])


def test_assert_distinct_concepts_too_few() -> None:
    with pytest.raises(VideoAdAuthoringError, match="at least 2"):
        assert_distinct_concepts([_concept("urgency", "h")])


def test_assert_distinct_concepts_dup_angle() -> None:
    with pytest.raises(VideoAdAuthoringError, match="distinct angle"):
        assert_distinct_concepts([
            _concept("urgency", "Hook one."),
            _concept("urgency", "Hook two.", label="v2"),
        ])


def test_assert_distinct_concepts_dup_hook() -> None:
    with pytest.raises(VideoAdAuthoringError, match="hooks must be distinct"):
        assert_distinct_concepts([
            _concept("urgency", "Same hook."),
            _concept("savings", "Same hook."),
        ])


def test_hook_styles_populated() -> None:
    assert "question" in HOOK_STYLES and "bold_claim" in HOOK_STYLES
