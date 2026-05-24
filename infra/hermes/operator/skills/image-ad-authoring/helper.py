"""Pure authoring utilities for local-services image ads.

This module is the *deterministic* half of the ``image-ad-authoring`` skill.
``SKILL.md`` carries the creative judgment (which angle, what offer framing,
how to compose a shot); this file carries the mechanical scaffolding the
agent leans on so every brief and every generation prompt comes out in a
consistent, validated, brand-safe shape.

Design rules (match the sibling dashboard skills):

* No I/O, no network, no environment access — these are pure functions, so
  importing the module is free and the unit tests need nothing mocked.
* One small public surface; raise :class:`ImageAdAuthoringError` on bad input
  so the agent (or the operator skill that calls it) fails loudly instead of
  emitting a malformed prompt that wastes a paid render.
* The vocabulary (angles, ratios, the negative-cue baseline) is kept narrow
  and named so the policy/methodology in ``SKILL.md`` and the worker's
  ``creatives`` schema stay in lock-step.

Nothing here talks to Kie, Supabase, or the worker. The ``pipeline-operator``
skill is what turns the dicts produced here into ``render`` calls.
"""

from __future__ import annotations

from typing import Any


class ImageAdAuthoringError(ValueError):
    """Raised when a brief or concept prompt is structurally invalid."""


# ---------------------------------------------------------------------------
# Controlled vocabulary
# ---------------------------------------------------------------------------

#: The angle library. These are the proven directions for local-services
#: lead-gen creative; ``SKILL.md`` documents when to reach for each. Keeping
#: them as a closed set means a typo ("urgancy") fails validation instead of
#: silently shipping an off-strategy concept. Values are the canonical slugs
#: stored in the concept name; the human-facing label lives in ``SKILL.md``.
ANGLES: dict[str, str] = {
    "before_after": "Visible transformation — the result the buyer wants.",
    "owner_led_trust": "A real owner/operator on-site; credibility and a face.",
    "social_proof": "Volume of happy customers / reviews / neighborhood saturation.",
    "urgency": "A reason to act now (season, slots filling, weather, deadline).",
    "savings": "The money math — the offer/discount as the hero.",
    "problem_agitation": "The pain of NOT acting (damage, risk, embarrassment).",
    "authority": "Licensed / certified / years in business / guarantees.",
}

#: Render ratios the worker supports (worker/src/services/kie.py). ``1x1`` is
#: the feed workhorse; ``9x16`` is the story/reel vertical. ``16x9`` exists in
#: the creatives schema but the operator pipeline only renders the first two.
RATIOS: frozenset[str] = frozenset({"1x1", "9x16", "16x9"})

#: Ratio intent — surfaced so the prompt author frames the SUBJECT for the
#: crop, not just slaps the same composition into both. Square reads at a
#: glance in-feed; vertical owns the screen and tolerates a stacked layout.
RATIO_INTENT: dict[str, str] = {
    "1x1": "Feed/grid. Single focal subject, centered or rule-of-thirds, "
    "legible as a 400px thumbnail. Offer in the lower third.",
    "9x16": "Story/Reel. Full-bleed vertical, subject fills the frame, "
    "safe margins top (status bar) and bottom (CTA bar). Stacked text.",
    "16x9": "Landscape/placement filler. Horizon-led, subject offset, "
    "room for a headline beside the subject.",
}

#: A baseline of negative cues every photoreal local-services prompt should
#: carry. These kill the tell-tale "AI ad" failure modes: garbled signage,
#: extra fingers, plastic skin, stock-photo staleness, and warped tools. The
#: author appends concept-specific negatives on top of this.
BASELINE_NEGATIVE_CUES: tuple[str, ...] = (
    "no garbled or misspelled text",
    "no warped or extra fingers",
    "no distorted faces",
    "no plastic or waxy skin",
    "no extra limbs",
    "no watermark or logo artifacts",
    "no lens distortion on straight edges",
    "no uncanny stock-photo smiles",
    "no cluttered or illegible signage",
)

#: Brand-safe text guidance. We do NOT bake long copy into the image — image
#: models mangle it. Keep on-image text to a SHORT offer stamp and let the ad
#: platform's caption carry the rest. This is the value we lint against.
MAX_ONIMAGE_TEXT_WORDS = 6


# ---------------------------------------------------------------------------
# Brief authoring
# ---------------------------------------------------------------------------

#: The keys the worker's brief endpoint requires (Wave A contract:
#: image_payload required keys market + offer_text + angles).
_REQUIRED_BRIEF_KEYS = ("market", "offer_text", "angles")


def build_image_brief(
    *,
    market: str,
    offer_text: str,
    angles: list[str],
    service_type: str | None = None,
    audience: str | None = None,
    extras: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Assemble a validated ``image_payload`` for the worker brief endpoint.

    The returned dict is exactly the ``image_payload`` body the
    ``pipeline-operator`` skill POSTs to ``/work/pipeline/tools/brief``. We
    validate here so a structurally broken brief never reaches the worker.

    Args:
        market: The geographic + service market, human readable
            (e.g. ``"Austin TX roofing"``). Required, non-empty.
        offer_text: The hook/offer in the customer's words
            (e.g. ``"$99 roof inspection"``). Required, non-empty. This is
            the single most important conversion lever — keep it concrete.
        angles: One or more angle slugs from :data:`ANGLES`. Order matters:
            the operator turns each angle into a distinct concept, so this
            list doubles as the concept plan. Duplicates are rejected.
        service_type: Optional normalized service (``"roofing"``, ``"hvac"``)
            for downstream filtering. Free-form.
        audience: Optional target-audience note
            (e.g. ``"homeowners 35-65, recent storm"``).
        extras: Optional pass-through keys (budget, brand colors, must-avoid
            claims). Merged last; cannot override a required key.

    Returns:
        A JSON-serializable ``image_payload`` dict.

    Raises:
        ImageAdAuthoringError: On any missing/blank required field, an
            unknown or duplicated angle, or an ``extras`` key that would
            clobber a required field.
    """
    market = _require_text("market", market)
    offer_text = _require_text("offer_text", offer_text)
    angles = normalize_angles(angles)

    payload: dict[str, Any] = {
        "market": market,
        "offer_text": offer_text,
        "angles": angles,
    }
    if service_type is not None:
        payload["service_type"] = _require_text("service_type", service_type)
    if audience is not None:
        payload["audience"] = _require_text("audience", audience)

    if extras:
        clobber = set(extras) & set(_REQUIRED_BRIEF_KEYS)
        if clobber:
            raise ImageAdAuthoringError(
                f"extras may not override required brief keys: {sorted(clobber)}"
            )
        payload.update(extras)

    return payload


def normalize_angles(angles: list[str]) -> list[str]:
    """Validate + de-duplicate an angle list, preserving order.

    Raises :class:`ImageAdAuthoringError` if empty, if any entry is not a
    known slug, or if a slug repeats (repeats mean the operator would author
    two concepts on the same angle — almost always a mistake).
    """
    if not isinstance(angles, list) or not angles:
        raise ImageAdAuthoringError("angles must be a non-empty list")
    seen: set[str] = set()
    out: list[str] = []
    for a in angles:
        if not isinstance(a, str) or not a.strip():
            raise ImageAdAuthoringError("each angle must be a non-empty string")
        slug = a.strip()
        if slug not in ANGLES:
            raise ImageAdAuthoringError(
                f"unknown angle {slug!r}; choose from {sorted(ANGLES)}"
            )
        if slug in seen:
            raise ImageAdAuthoringError(f"duplicate angle {slug!r}")
        seen.add(slug)
        out.append(slug)
    return out


# ---------------------------------------------------------------------------
# Concept-prompt authoring
# ---------------------------------------------------------------------------


def build_concept_prompt(
    *,
    angle: str,
    subject: str,
    setting: str,
    lighting: str,
    lens: str,
    mood: str,
    ratio: str = "1x1",
    onimage_text: str | None = None,
    extra_negatives: list[str] | None = None,
) -> str:
    """Compose one photoreal generation prompt from its craft components.

    This is the assembler behind the methodology: the author decides the
    creative content of each field; this function orders them into a single
    prompt string the worker passes straight to Kie, and appends the
    baseline + concept-specific negative cues so the tell-tale AI failure
    modes are suppressed every time.

    The field order is deliberate — image models weight earlier tokens more,
    so SUBJECT and SETTING (what the ad is *about*) lead, then the
    photographic controls (lighting, lens, mood) that make it read as a real
    photo rather than a render, then the ratio-intent framing, then the
    short on-image offer stamp, then negatives.

    Args:
        angle: Angle slug from :data:`ANGLES` (ties the prompt to strategy).
        subject: The hero of the shot, concrete and human where possible
            (e.g. ``"a roofer in a branded polo shaking hands with a
            homeowner on a finished roof"``).
        setting: Where it happens — real, specific, on-location
            (e.g. ``"a suburban Austin home, fresh architectural shingles"``).
        lighting: The light quality (e.g. ``"golden-hour side light, soft
            shadows"``). Drives realism more than any other single field.
        lens: The optics (e.g. ``"35mm, f/2.8, slight depth of field"``).
        mood: The feeling the buyer should get (e.g. ``"trustworthy,
            relieved, premium"``).
        ratio: Render ratio; selects the framing guidance from
            :data:`RATIO_INTENT`. Defaults to ``1x1``.
        onimage_text: OPTIONAL short offer stamp baked into the image
            (<= :data:`MAX_ONIMAGE_TEXT_WORDS` words). Omit for clean
            concept previews and let the platform caption carry copy.
        extra_negatives: Concept-specific negative cues appended after the
            baseline (e.g. ``["no ladder in frame", "no debris"]``).

    Returns:
        A single prompt string ready for the worker's ``render`` items.

    Raises:
        ImageAdAuthoringError: On unknown angle/ratio, a blank required
            craft field, or on-image text that exceeds the word budget.
    """
    if angle not in ANGLES:
        raise ImageAdAuthoringError(
            f"unknown angle {angle!r}; choose from {sorted(ANGLES)}"
        )
    if ratio not in RATIOS:
        raise ImageAdAuthoringError(
            f"unknown ratio {ratio!r}; choose from {sorted(RATIOS)}"
        )

    subject = _require_text("subject", subject)
    setting = _require_text("setting", setting)
    lighting = _require_text("lighting", lighting)
    lens = _require_text("lens", lens)
    mood = _require_text("mood", mood)

    segments = [
        f"Photorealistic local-services advertising photograph. {subject}.",
        f"Setting: {setting}.",
        f"Lighting: {lighting}.",
        f"Shot on {lens}.",
        f"Mood: {mood}.",
        f"Composition: {RATIO_INTENT[ratio]}",
    ]

    if onimage_text is not None:
        stamp = validate_onimage_text(onimage_text)
        segments.append(
            f'Clean, legible on-image text reading exactly "{stamp}" '
            "as a small offer stamp; everything else in the frame is "
            "free of text."
        )

    negatives = list(BASELINE_NEGATIVE_CUES)
    if extra_negatives:
        for n in extra_negatives:
            if isinstance(n, str) and n.strip():
                negatives.append(n.strip())
    segments.append("Avoid: " + "; ".join(negatives) + ".")

    return " ".join(segments)


def validate_onimage_text(text: str) -> str:
    """Lint a candidate on-image text stamp; return it trimmed.

    Image models reliably render only short text. We cap at
    :data:`MAX_ONIMAGE_TEXT_WORDS` words so the author keeps real copy in the
    platform caption (where it stays crisp) rather than asking the model to
    paint a paragraph it will mangle.
    """
    text = _require_text("onimage_text", text)
    words = text.split()
    if len(words) > MAX_ONIMAGE_TEXT_WORDS:
        raise ImageAdAuthoringError(
            f"on-image text is {len(words)} words; keep it to "
            f"{MAX_ONIMAGE_TEXT_WORDS} or fewer and put the rest in the caption"
        )
    return text


def build_concept(
    *,
    angle: str,
    concept_label: str,
    subject: str,
    setting: str,
    lighting: str,
    lens: str,
    mood: str,
    ratio: str = "1x1",
    offer_text: str | None = None,
    onimage_text: str | None = None,
    extra_negatives: list[str] | None = None,
) -> dict[str, str]:
    """Build one render-ready concept dict (``{concept, prompt, offer_text?}``).

    The shape matches an item in the worker ``render`` body
    (Wave A: ``items:[{concept, prompt, offer_text?, parent_creative_id?}]``).
    ``concept`` is a stable, human-readable label prefixed with its angle so
    the dashboard and the ``creatives`` rows are self-describing.

    Returns:
        ``{"concept": "<angle>__<label>", "prompt": "<full prompt>"}`` plus
        ``"offer_text"`` when supplied.

    Raises:
        ImageAdAuthoringError: Propagated from the underlying validators.
    """
    if angle not in ANGLES:
        raise ImageAdAuthoringError(
            f"unknown angle {angle!r}; choose from {sorted(ANGLES)}"
        )
    label = _slugify(_require_text("concept_label", concept_label))
    prompt = build_concept_prompt(
        angle=angle,
        subject=subject,
        setting=setting,
        lighting=lighting,
        lens=lens,
        mood=mood,
        ratio=ratio,
        onimage_text=onimage_text,
        extra_negatives=extra_negatives,
    )
    concept: dict[str, str] = {"concept": f"{angle}__{label}", "prompt": prompt}
    if offer_text is not None:
        concept["offer_text"] = _require_text("offer_text", offer_text)
    return concept


def assert_distinct_concepts(concepts: list[dict[str, str]]) -> None:
    """Guard that a concept set is genuinely varied before a (paid) render.

    A concept *preview* batch exists to give the manager real choices. Two
    concepts that share an angle OR a near-identical prompt waste a render
    slot. We enforce: at least two concepts, unique ``concept`` labels,
    unique angles (the slug before ``__``), and unique prompts.

    Raises:
        ImageAdAuthoringError: If the set is too small or insufficiently
            distinct.
    """
    if not isinstance(concepts, list) or len(concepts) < 2:
        raise ImageAdAuthoringError(
            "a concept set needs at least 2 distinct concepts"
        )
    labels = [c.get("concept", "") for c in concepts]
    if len(set(labels)) != len(labels):
        raise ImageAdAuthoringError("concept labels must be unique")
    angles = [lbl.split("__", 1)[0] for lbl in labels]
    if len(set(angles)) != len(angles):
        raise ImageAdAuthoringError(
            "each concept must use a distinct angle for a real choice"
        )
    prompts = [c.get("prompt", "") for c in concepts]
    if len(set(prompts)) != len(prompts):
        raise ImageAdAuthoringError("concept prompts must be distinct")


# ---------------------------------------------------------------------------
# Internals
# ---------------------------------------------------------------------------


def _require_text(field: str, value: Any) -> str:
    """Return a stripped non-empty string or raise with the field name."""
    if not isinstance(value, str) or not value.strip():
        raise ImageAdAuthoringError(f"{field} must be a non-empty string")
    return value.strip()


def _slugify(text: str) -> str:
    """Lowercase, hyphenate; keep ``[a-z0-9-]`` only. Stable concept labels."""
    out = []
    prev_dash = False
    for ch in text.lower():
        if ch.isalnum():
            out.append(ch)
            prev_dash = False
        elif not prev_dash:
            out.append("-")
            prev_dash = True
    return "".join(out).strip("-") or "concept"


__all__ = [
    "ANGLES",
    "BASELINE_NEGATIVE_CUES",
    "ImageAdAuthoringError",
    "MAX_ONIMAGE_TEXT_WORDS",
    "RATIO_INTENT",
    "RATIOS",
    "assert_distinct_concepts",
    "build_concept",
    "build_concept_prompt",
    "build_image_brief",
    "normalize_angles",
    "validate_onimage_text",
]
