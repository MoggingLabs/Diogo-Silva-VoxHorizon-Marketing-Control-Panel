"""Unit tests for the ``image-ad-authoring`` helper.

Pure functions, so there is nothing to mock — we assert on validation
behavior and on the structure/ordering of the assembled brief and prompt
strings. We exercise:

* Brief assembly: required fields, optional fields, extras merge + clobber
  guard, angle validation.
* Angle normalization: empty, unknown, duplicate, order preservation.
* Prompt assembly: field ordering, ratio framing injection, baseline +
  extra negatives, on-image text stamping + word-budget lint.
* Concept assembly: label slugging, angle-prefixed concept name, offer_text
  pass-through.
* Distinctness guard: too few, duplicate labels, duplicate angles, duplicate
  prompts.
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
    BASELINE_NEGATIVE_CUES,
    MAX_ONIMAGE_TEXT_WORDS,
    RATIO_INTENT,
    ImageAdAuthoringError,
    assert_distinct_concepts,
    build_concept,
    build_concept_prompt,
    build_image_brief,
    normalize_angles,
    validate_onimage_text,
)


# ---------------------------------------------------------------------------
# build_image_brief
# ---------------------------------------------------------------------------


def test_build_brief_minimal_required_fields() -> None:
    payload = build_image_brief(
        market="Austin TX roofing",
        offer_text="$99 roof inspection",
        angles=["before_after", "savings"],
    )
    assert payload == {
        "market": "Austin TX roofing",
        "offer_text": "$99 roof inspection",
        "angles": ["before_after", "savings"],
    }


def test_build_brief_strips_whitespace() -> None:
    payload = build_image_brief(
        market="  Austin  ",
        offer_text="  $99 inspection ",
        angles=["savings"],
    )
    assert payload["market"] == "Austin"
    assert payload["offer_text"] == "$99 inspection"


def test_build_brief_includes_optional_fields() -> None:
    payload = build_image_brief(
        market="Austin",
        offer_text="$99",
        angles=["savings"],
        service_type="roofing",
        audience="homeowners 35-65",
    )
    assert payload["service_type"] == "roofing"
    assert payload["audience"] == "homeowners 35-65"


def test_build_brief_merges_extras() -> None:
    payload = build_image_brief(
        market="Austin",
        offer_text="$99",
        angles=["savings"],
        extras={"budget_per_day": 50, "must_avoid": ["guaranteed approval"]},
    )
    assert payload["budget_per_day"] == 50
    assert payload["must_avoid"] == ["guaranteed approval"]


def test_build_brief_extras_cannot_clobber_required() -> None:
    with pytest.raises(ImageAdAuthoringError, match="override required"):
        build_image_brief(
            market="Austin",
            offer_text="$99",
            angles=["savings"],
            extras={"offer_text": "sneaky override"},
        )


@pytest.mark.parametrize("blank", ["", "   ", None])
def test_build_brief_rejects_blank_market(blank) -> None:
    with pytest.raises(ImageAdAuthoringError, match="market"):
        build_image_brief(
            market=blank,  # type: ignore[arg-type]
            offer_text="$99",
            angles=["savings"],
        )


def test_build_brief_rejects_blank_offer() -> None:
    with pytest.raises(ImageAdAuthoringError, match="offer_text"):
        build_image_brief(market="Austin", offer_text="  ", angles=["savings"])


# ---------------------------------------------------------------------------
# normalize_angles
# ---------------------------------------------------------------------------


def test_normalize_angles_preserves_order() -> None:
    assert normalize_angles(["urgency", "savings", "before_after"]) == [
        "urgency",
        "savings",
        "before_after",
    ]


def test_normalize_angles_empty_raises() -> None:
    with pytest.raises(ImageAdAuthoringError, match="non-empty list"):
        normalize_angles([])


def test_normalize_angles_unknown_raises() -> None:
    with pytest.raises(ImageAdAuthoringError, match="unknown angle"):
        normalize_angles(["before_after", "urgancy"])


def test_normalize_angles_duplicate_raises() -> None:
    with pytest.raises(ImageAdAuthoringError, match="duplicate angle"):
        normalize_angles(["savings", "savings"])


def test_normalize_angles_non_string_raises() -> None:
    with pytest.raises(ImageAdAuthoringError, match="non-empty string"):
        normalize_angles([123])  # type: ignore[list-item]


def test_every_documented_angle_is_valid() -> None:
    """Every slug in the published vocabulary normalizes cleanly."""
    for slug in ANGLES:
        assert normalize_angles([slug]) == [slug]


# ---------------------------------------------------------------------------
# build_concept_prompt
# ---------------------------------------------------------------------------


def _prompt(**overrides):
    base = dict(
        angle="owner_led_trust",
        subject="a roofer shaking hands with a homeowner",
        setting="a suburban Austin home with a new roof",
        lighting="golden-hour side light",
        lens="35mm, f/2.8",
        mood="trustworthy",
    )
    base.update(overrides)
    return build_concept_prompt(**base)


def test_prompt_orders_subject_before_lighting() -> None:
    p = _prompt()
    assert p.index("shaking hands") < p.index("Lighting:")
    assert p.index("Lighting:") < p.index("Shot on")


def test_prompt_injects_ratio_framing() -> None:
    p_square = _prompt(ratio="1x1")
    p_vert = _prompt(ratio="9x16")
    assert RATIO_INTENT["1x1"] in p_square
    assert RATIO_INTENT["9x16"] in p_vert
    assert p_square != p_vert


def test_prompt_includes_baseline_negatives() -> None:
    p = _prompt()
    assert "Avoid:" in p
    for cue in BASELINE_NEGATIVE_CUES:
        assert cue in p


def test_prompt_appends_extra_negatives() -> None:
    p = _prompt(extra_negatives=["no ladder in frame", "no debris"])
    assert "no ladder in frame" in p
    assert "no debris" in p


def test_prompt_skips_blank_extra_negatives() -> None:
    p = _prompt(extra_negatives=["", "   ", "no debris"])
    assert "no debris" in p
    # No empty fragment leaks into the "Avoid:" join.
    assert "; ;" not in p


def test_prompt_onimage_text_stamped_verbatim() -> None:
    p = _prompt(onimage_text="$99 inspection")
    assert '"$99 inspection"' in p


def test_prompt_without_onimage_text_has_no_stamp() -> None:
    p = _prompt()
    assert "on-image text" not in p.lower()


def test_prompt_unknown_angle_raises() -> None:
    with pytest.raises(ImageAdAuthoringError, match="unknown angle"):
        _prompt(angle="nope")


def test_prompt_unknown_ratio_raises() -> None:
    with pytest.raises(ImageAdAuthoringError, match="unknown ratio"):
        _prompt(ratio="4x5")


@pytest.mark.parametrize("field", ["subject", "setting", "lighting", "lens", "mood"])
def test_prompt_blank_craft_field_raises(field: str) -> None:
    with pytest.raises(ImageAdAuthoringError, match=field):
        _prompt(**{field: "  "})


# ---------------------------------------------------------------------------
# validate_onimage_text
# ---------------------------------------------------------------------------


def test_onimage_text_within_budget_ok() -> None:
    assert validate_onimage_text("Free AC tune-up today now") == (
        "Free AC tune-up today now"
    )


def test_onimage_text_over_budget_raises() -> None:
    too_long = " ".join(["word"] * (MAX_ONIMAGE_TEXT_WORDS + 1))
    with pytest.raises(ImageAdAuthoringError, match="words"):
        validate_onimage_text(too_long)


def test_onimage_text_blank_raises() -> None:
    with pytest.raises(ImageAdAuthoringError, match="onimage_text"):
        validate_onimage_text("   ")


# ---------------------------------------------------------------------------
# build_concept
# ---------------------------------------------------------------------------


def test_build_concept_shape_and_label() -> None:
    c = build_concept(
        angle="savings",
        concept_label="Ninety-Nine Dollar Hero!",
        subject="a homeowner reviewing a clean report",
        setting="a tidy front porch",
        lighting="soft overcast diffusion",
        lens="50mm, f/2.8",
        mood="smart, satisfied",
    )
    assert c["concept"] == "savings__ninety-nine-dollar-hero"
    assert c["prompt"].startswith("Photorealistic local-services")
    assert "offer_text" not in c


def test_build_concept_passes_offer_text() -> None:
    c = build_concept(
        angle="savings",
        concept_label="value",
        subject="x subject here",
        setting="y setting here",
        lighting="soft light",
        lens="50mm",
        mood="smart",
        offer_text="$99 inspection",
    )
    assert c["offer_text"] == "$99 inspection"


def test_build_concept_unknown_angle_raises() -> None:
    with pytest.raises(ImageAdAuthoringError, match="unknown angle"):
        build_concept(
            angle="bogus",
            concept_label="x",
            subject="s subject",
            setting="g setting",
            lighting="l",
            lens="35mm",
            mood="m",
        )


# ---------------------------------------------------------------------------
# assert_distinct_concepts
# ---------------------------------------------------------------------------


def _set(*angles):
    """Build a minimal distinct-by-construction concept set for N angles."""
    return [
        build_concept(
            angle=a,
            concept_label=f"label-{i}",
            subject=f"subject number {i} on location",
            setting=f"setting number {i} suburban",
            lighting="soft daylight",
            lens="35mm",
            mood="trustworthy",
        )
        for i, a in enumerate(angles)
    ]


def test_distinct_set_passes() -> None:
    concepts = _set("before_after", "owner_led_trust", "savings", "urgency")
    assert_distinct_concepts(concepts)  # no raise


def test_distinct_requires_at_least_two() -> None:
    with pytest.raises(ImageAdAuthoringError, match="at least 2"):
        assert_distinct_concepts(_set("savings"))


def test_distinct_rejects_duplicate_angles() -> None:
    # Two concepts on the same angle but different labels → not a real choice.
    concepts = [
        build_concept(
            angle="savings",
            concept_label="a",
            subject="subject a here",
            setting="setting a here",
            lighting="soft",
            lens="35mm",
            mood="m",
        ),
        build_concept(
            angle="savings",
            concept_label="b",
            subject="subject b here",
            setting="setting b here",
            lighting="soft",
            lens="35mm",
            mood="m",
        ),
    ]
    with pytest.raises(ImageAdAuthoringError, match="distinct angle"):
        assert_distinct_concepts(concepts)


def test_distinct_rejects_duplicate_labels() -> None:
    concepts = _set("before_after", "savings")
    concepts[1]["concept"] = concepts[0]["concept"]  # force a label collision
    with pytest.raises(ImageAdAuthoringError, match="labels must be unique"):
        assert_distinct_concepts(concepts)


def test_distinct_rejects_duplicate_prompts() -> None:
    concepts = _set("before_after", "savings")
    concepts[1]["prompt"] = concepts[0]["prompt"]  # identical prompt
    with pytest.raises(ImageAdAuthoringError, match="prompts must be distinct"):
        assert_distinct_concepts(concepts)
