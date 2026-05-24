"""Pure authoring utilities for local-services VIDEO ads.

This module is the *deterministic* half of the ``video-ad-authoring`` skill.
``SKILL.md`` carries the creative judgment (which angle, what hook, how to write
a voiceover that does not sound like an AI, how to brief b-roll); this file
carries the mechanical scaffolding so every brief and every script concept comes
out in a consistent, validated shape that the worker can run without surprises.

Sibling of :mod:`ekko-skills.image-ad-authoring.helper`. The two share the same
angle vocabulary (the strategy is identical across formats) but video adds a
script model: a hook, 1-4 timed segments (each with voiceover + b-roll briefing),
and an outro. The segment shape here is kept in lock-step with the worker's video
``script`` substage validator (``worker/src/routes/video.py`` _parse_script_output:
top-level ``hook`` / ``segments`` / ``outro`` / ``total_duration_s``; each segment
``idx`` / ``topic`` / ``duration_s`` / ``voiceover_text`` / ``voiceover_direction``
/ ``broll_query`` / ``broll_intent`` / ``captions_emphasis``; ``idx`` 0-contiguous)
so a script authored here passes generation without a 502.

Design rules (match image-ad-authoring + the dashboard skills):

* No I/O, no network, no environment access -- pure functions, free to import,
  nothing to mock in the unit tests.
* One small public surface; raise :class:`VideoAdAuthoringError` on bad input so
  the agent fails loudly instead of emitting a malformed script that wastes a
  paid voiceover/generation pass.
* Narrow, named vocabulary (angles, hook styles, b-roll intents, banned VO words)
  so the methodology in ``SKILL.md`` and the worker schema stay aligned.

Nothing here talks to kie, Supabase, or the worker. The ``pipeline-operator``
skill turns the dicts produced here into ``video_brief`` / ``video_render`` calls.
"""

from __future__ import annotations

from typing import Any


class VideoAdAuthoringError(ValueError):
    """Raised when a video brief, segment, script, or concept is invalid."""


# ---------------------------------------------------------------------------
# Controlled vocabulary
# ---------------------------------------------------------------------------

#: The angle library. Identical strategy set to the image skill -- these are the
#: proven directions for local-services lead-gen creative. Closed set so a typo
#: fails validation instead of shipping an off-strategy concept. ``SKILL.md``
#: documents when to reach for each.
ANGLES: dict[str, str] = {
    "before_after": "Visible transformation -- the result the buyer wants.",
    "owner_led_trust": "A real owner/operator on camera; credibility and a face.",
    "social_proof": "Volume of happy customers / reviews / neighborhood saturation.",
    "urgency": "A reason to act now (season, slots filling, weather, deadline).",
    "savings": "The money math -- the offer/discount as the hero.",
    "problem_agitation": "The pain of NOT acting (damage, risk, embarrassment).",
    "authority": "Licensed / certified / years in business / guarantees.",
}

#: Hook styles for the first 1-3 seconds -- the single biggest lever on watch
#: time for short-form. Closed set; ``SKILL.md`` gives an example line for each.
HOOK_STYLES: dict[str, str] = {
    "question": "Open with the buyer's nagging question.",
    "bold_claim": "A specific, credible promise stated flat.",
    "pattern_interrupt": "An unexpected visual/line that stops the scroll.",
    "stat_shock": "A surprising number that reframes the problem.",
    "problem_callout": "Name the exact pain in the buyer's words.",
    "social_proof": "Lead with proof/volume (neighbors, reviews, jobs done).",
}

#: B-roll intent per segment -- what the footage must DO, not just show. Drives
#: both generation prompts and stock search, and the compliance review keys on
#: it (e.g. ``demonstrate`` of the real service is a misrepresentation risk).
BROLL_INTENTS: dict[str, str] = {
    "establish": "Set the scene / location so the viewer is oriented.",
    "demonstrate": "Show the work or result in action.",
    "before_after": "Contrast the problem state with the finished state.",
    "proof": "Reviews, ratings, credentials, crew on site -- credibility.",
    "product_focus": "Tight on the offer/product/material as the hero.",
    "lifestyle": "The relieved/happy outcome for the homeowner.",
}

#: B-roll sourcing modes the worker's broll-select stage understands
#: (worker BrollSelectRequest). ``auto`` is the generation default.
BROLL_SELECTION_MODES: frozenset[str] = frozenset(
    {"auto", "review_each", "review_low_confidence"}
)

#: Short-form vertical is the only shipping format for the video pipeline v1.
DEFAULT_DIMENSIONS = "9x16"
DIMENSIONS: frozenset[str] = frozenset({"9x16", "1x1", "16x9"})

#: Script shape limits, kept in lock-step with the worker validator.
MIN_SEGMENTS = 1
MAX_SEGMENTS = 4
#: A short-form ad runs roughly 8-90s; each segment is a couple seconds to a
#: short beat. Bounds catch a script that would never assemble cleanly.
MIN_TOTAL_DURATION_S = 6
MAX_TOTAL_DURATION_S = 90
MIN_SEGMENT_DURATION_S = 2
MAX_SEGMENT_DURATION_S = 20
#: Per-segment voiceover stays short so captions stay legible and the TTS call
#: stays well under the kie/ElevenLabs per-request limit.
MAX_VOICEOVER_WORDS = 60

#: AI-tell words. A voiceover that leans on these reads as machine-written and
#: tanks trust for a local-services ad. The humanizer pass (see ``SKILL.md``)
#: rewrites around them; we lint so they never ship silently. Lowercased.
BANNED_VOICEOVER_WORDS: tuple[str, ...] = (
    "unleash",
    "elevate",
    "game-changer",
    "game changer",
    "revolutionary",
    "seamless",
    "cutting-edge",
    "cutting edge",
    "unlock",
    "supercharge",
    "transformative",
    "in today's fast-paced world",
    "look no further",
    "tapestry",
    "elevate your",
    "take it to the next level",
)


# ---------------------------------------------------------------------------
# Brief authoring
# ---------------------------------------------------------------------------

#: Keys the worker's brief endpoint requires for a video payload (mirrors the
#: image contract market + offer_text + angles, plus the video essentials).
_REQUIRED_BRIEF_KEYS = ("market", "offer_text", "angles", "target_duration_s", "voice_id")


def build_video_brief(
    *,
    market: str,
    offer_text: str,
    angles: list[str],
    target_duration_s: int,
    voice_id: str,
    broll_selection_mode: str = "auto",
    hook_style: str | None = None,
    music: bool | None = None,
    dimensions: str = DEFAULT_DIMENSIONS,
    captions_style: str | None = None,
    service_type: str | None = None,
    audience: str | None = None,
    extras: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Assemble a validated ``video_payload`` for the worker brief endpoint.

    The returned dict is the ``video_payload`` body the ``pipeline-operator``
    skill POSTs for a video brief. Validated here so a broken brief never reaches
    the worker.

    Args:
        market: Geographic + service market (e.g. ``"Austin TX roofing"``).
        offer_text: The hook/offer in the buyer's words (e.g. ``"$99 roof
            inspection"``). The single biggest conversion lever; keep it concrete.
        angles: One or more angle slugs from :data:`ANGLES`; order doubles as the
            concept plan (one distinct script concept per angle). Duplicates are
            rejected.
        target_duration_s: Intended finished length in seconds
            (:data:`MIN_TOTAL_DURATION_S`..:data:`MAX_TOTAL_DURATION_S`).
        voice_id: The TTS voice id for the voiceover. Required -- the worker's
            voiceover stage 409s without it.
        broll_selection_mode: One of :data:`BROLL_SELECTION_MODES`.
        hook_style: Optional default hook style from :data:`HOOK_STYLES`.
        music: Optional flag to request a background-music bed (licensing is a
            compliance class; off by default).
        dimensions: Aspect from :data:`DIMENSIONS`; vertical ``9x16`` default.
        captions_style: Optional caption style label passed through to compose.
        service_type / audience: Optional free-form normalizers.
        extras: Optional pass-through keys; merged last, cannot clobber a
            required key.

    Raises:
        VideoAdAuthoringError: On any invalid field or a clobbering ``extras`` key.
    """
    payload: dict[str, Any] = {
        "market": _require_text("market", market),
        "offer_text": _require_text("offer_text", offer_text),
        "angles": normalize_angles(angles),
        "target_duration_s": _require_int(
            "target_duration_s",
            target_duration_s,
            MIN_TOTAL_DURATION_S,
            MAX_TOTAL_DURATION_S,
        ),
        "voice_id": _require_text("voice_id", voice_id),
        "dimensions": _require_choice("dimensions", dimensions, DIMENSIONS),
        "broll_selection_mode": _require_choice(
            "broll_selection_mode", broll_selection_mode, BROLL_SELECTION_MODES
        ),
    }
    if hook_style is not None:
        payload["hook_style"] = _require_key("hook_style", hook_style, HOOK_STYLES)
    if music is not None:
        payload["music"] = bool(music)
    if captions_style is not None:
        payload["captions_style"] = _require_text("captions_style", captions_style)
    if service_type is not None:
        payload["service_type"] = _require_text("service_type", service_type)
    if audience is not None:
        payload["audience"] = _require_text("audience", audience)

    if extras:
        clobber = set(extras) & set(_REQUIRED_BRIEF_KEYS)
        if clobber:
            raise VideoAdAuthoringError(
                f"extras may not override required brief keys: {sorted(clobber)}"
            )
        payload.update(extras)

    return payload


def normalize_angles(angles: list[str]) -> list[str]:
    """Validate + de-duplicate an angle list, preserving order.

    Raises :class:`VideoAdAuthoringError` if empty, if any entry is not a known
    slug, or if a slug repeats (a repeat means two concepts on the same angle).
    """
    if not isinstance(angles, list) or not angles:
        raise VideoAdAuthoringError("angles must be a non-empty list")
    seen: set[str] = set()
    out: list[str] = []
    for a in angles:
        if not isinstance(a, str) or not a.strip():
            raise VideoAdAuthoringError("each angle must be a non-empty string")
        slug = a.strip()
        if slug not in ANGLES:
            raise VideoAdAuthoringError(
                f"unknown angle {slug!r}; choose from {sorted(ANGLES)}"
            )
        if slug in seen:
            raise VideoAdAuthoringError(f"duplicate angle {slug!r}")
        seen.add(slug)
        out.append(slug)
    return out


# ---------------------------------------------------------------------------
# Script authoring (hook + segments + outro)
# ---------------------------------------------------------------------------


def validate_voiceover_text(text: str) -> str:
    """Lint a segment voiceover line; return it trimmed.

    Enforces a short word budget (:data:`MAX_VOICEOVER_WORDS`) so captions stay
    legible and the TTS call stays small, and rejects the AI-tell words in
    :data:`BANNED_VOICEOVER_WORDS` so the humanizer pass is not skipped.
    """
    text = _require_text("voiceover_text", text)
    words = text.split()
    if len(words) > MAX_VOICEOVER_WORDS:
        raise VideoAdAuthoringError(
            f"voiceover_text is {len(words)} words; keep each segment to "
            f"{MAX_VOICEOVER_WORDS} or fewer"
        )
    lowered = text.lower()
    hits = [w for w in BANNED_VOICEOVER_WORDS if w in lowered]
    if hits:
        raise VideoAdAuthoringError(
            f"voiceover_text uses AI-tell words {hits}; run the humanizer pass "
            f"and rewrite in plain spoken language"
        )
    return text


def build_segment(
    *,
    idx: int,
    topic: str,
    duration_s: int,
    voiceover_text: str,
    voiceover_direction: str,
    broll_query: str,
    broll_intent: str,
    captions_emphasis: list[str] | None = None,
) -> dict[str, Any]:
    """Build one validated script segment matching the worker schema.

    Returns a dict with exactly the keys the worker's ``script`` validator
    requires. ``captions_emphasis`` is the list of words to visually punch in the
    burned-in captions (defaults to empty).

    Raises:
        VideoAdAuthoringError: On a bad idx/duration, a blank field, an unknown
            ``broll_intent``, or banned voiceover words.
    """
    if not isinstance(idx, int) or isinstance(idx, bool) or idx < 0:
        raise VideoAdAuthoringError("segment idx must be an int >= 0")
    emphasis = captions_emphasis or []
    if not isinstance(emphasis, list) or not all(
        isinstance(w, str) and w.strip() for w in emphasis
    ):
        raise VideoAdAuthoringError(
            "captions_emphasis must be a list of non-empty strings"
        )
    return {
        "idx": idx,
        "topic": _require_text("topic", topic),
        "duration_s": _require_int(
            "duration_s",
            duration_s,
            MIN_SEGMENT_DURATION_S,
            MAX_SEGMENT_DURATION_S,
        ),
        "voiceover_text": validate_voiceover_text(voiceover_text),
        "voiceover_direction": _require_text("voiceover_direction", voiceover_direction),
        "broll_query": _require_text("broll_query", broll_query),
        "broll_intent": _require_key("broll_intent", broll_intent, BROLL_INTENTS),
        "captions_emphasis": [w.strip() for w in emphasis],
    }


def build_script(
    *,
    hook: str,
    segments: list[dict[str, Any]],
    outro: str,
    target_duration_s: int | None = None,
    tolerance_s: int = 4,
) -> dict[str, Any]:
    """Assemble + validate a full script object (hook, segments, outro).

    Validates the segment count (:data:`MIN_SEGMENTS`..:data:`MAX_SEGMENTS`) and
    that ``idx`` values are 0-contiguous, computes ``total_duration_s`` as the sum
    of segment durations, and -- when ``target_duration_s`` is given -- checks the
    total lands within ``tolerance_s`` of it. Returns the worker-shaped dict
    ``{hook, segments, outro, total_duration_s}``.

    Raises:
        VideoAdAuthoringError: On count/contiguity/duration problems.
    """
    hook = _require_text("hook", hook)
    outro = _require_text("outro", outro)
    if not isinstance(segments, list) or not (
        MIN_SEGMENTS <= len(segments) <= MAX_SEGMENTS
    ):
        raise VideoAdAuthoringError(
            f"segments must be a list of {MIN_SEGMENTS}-{MAX_SEGMENTS} entries"
        )
    idxs = [s.get("idx") for s in segments]
    if idxs != list(range(len(segments))):
        raise VideoAdAuthoringError(
            f"segment idx values must be 0-contiguous, got {idxs!r}"
        )
    total = sum(int(s["duration_s"]) for s in segments)
    if not (MIN_TOTAL_DURATION_S <= total <= MAX_TOTAL_DURATION_S):
        raise VideoAdAuthoringError(
            f"total duration {total}s outside "
            f"[{MIN_TOTAL_DURATION_S}, {MAX_TOTAL_DURATION_S}]"
        )
    if target_duration_s is not None and abs(total - target_duration_s) > tolerance_s:
        raise VideoAdAuthoringError(
            f"segment durations sum to {total}s; target is {target_duration_s}s "
            f"(tolerance {tolerance_s}s) -- adjust segment timings"
        )
    return {
        "hook": hook,
        "segments": segments,
        "outro": outro,
        "total_duration_s": total,
    }


# ---------------------------------------------------------------------------
# Concept authoring (one script concept per angle)
# ---------------------------------------------------------------------------


def build_video_concept(
    *,
    angle: str,
    concept_label: str,
    hook: str,
    segments: list[dict[str, Any]],
    outro: str,
    target_duration_s: int | None = None,
) -> dict[str, Any]:
    """Build one ideation concept: an angle-tagged label plus a full script.

    Mirrors the image skill's ``build_concept`` but the payload is a whole script
    (the unit the operator picks between at Review). ``concept`` is a stable,
    angle-prefixed label so the ``video_creatives`` rows are self-describing.

    Returns ``{"concept": "<angle>__<label>", "angle": angle,
    "script": {...}}``.
    """
    if angle not in ANGLES:
        raise VideoAdAuthoringError(
            f"unknown angle {angle!r}; choose from {sorted(ANGLES)}"
        )
    label = _slugify(_require_text("concept_label", concept_label))
    script = build_script(
        hook=hook,
        segments=segments,
        outro=outro,
        target_duration_s=target_duration_s,
    )
    return {"concept": f"{angle}__{label}", "angle": angle, "script": script}


def assert_distinct_concepts(concepts: list[dict[str, Any]]) -> None:
    """Guard that a concept set is genuinely varied before generation.

    A concept preview batch exists to give the manager real choices. We enforce:
    at least two concepts, unique ``concept`` labels, unique angles, and unique
    hooks (for video the opening line is the primary differentiator).

    Raises:
        VideoAdAuthoringError: If the set is too small or insufficiently distinct.
    """
    if not isinstance(concepts, list) or len(concepts) < 2:
        raise VideoAdAuthoringError(
            "a concept set needs at least 2 distinct concepts"
        )
    labels = [c.get("concept", "") for c in concepts]
    if len(set(labels)) != len(labels):
        raise VideoAdAuthoringError("concept labels must be unique")
    angles = [c.get("angle") or lbl.split("__", 1)[0] for c, lbl in zip(concepts, labels)]
    if len(set(angles)) != len(angles):
        raise VideoAdAuthoringError(
            "each concept must use a distinct angle for a real choice"
        )
    hooks = [(c.get("script") or {}).get("hook", "") for c in concepts]
    if len(set(hooks)) != len(hooks):
        raise VideoAdAuthoringError("concept hooks must be distinct")


# ---------------------------------------------------------------------------
# Internals
# ---------------------------------------------------------------------------


def _require_text(field: str, value: Any) -> str:
    if not isinstance(value, str) or not value.strip():
        raise VideoAdAuthoringError(f"{field} must be a non-empty string")
    return value.strip()


def _require_int(field: str, value: Any, lo: int, hi: int) -> int:
    if not isinstance(value, int) or isinstance(value, bool):
        raise VideoAdAuthoringError(f"{field} must be an int")
    if not (lo <= value <= hi):
        raise VideoAdAuthoringError(f"{field} must be in [{lo}, {hi}], got {value}")
    return value


def _require_choice(field: str, value: Any, choices: frozenset[str]) -> str:
    value = _require_text(field, value)
    if value not in choices:
        raise VideoAdAuthoringError(
            f"unknown {field} {value!r}; choose from {sorted(choices)}"
        )
    return value


def _require_key(field: str, value: Any, table: dict[str, str]) -> str:
    value = _require_text(field, value)
    if value not in table:
        raise VideoAdAuthoringError(
            f"unknown {field} {value!r}; choose from {sorted(table)}"
        )
    return value


def _slugify(text: str) -> str:
    out: list[str] = []
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
    "BANNED_VOICEOVER_WORDS",
    "BROLL_INTENTS",
    "BROLL_SELECTION_MODES",
    "DEFAULT_DIMENSIONS",
    "DIMENSIONS",
    "HOOK_STYLES",
    "MAX_SEGMENTS",
    "MAX_VOICEOVER_WORDS",
    "MIN_SEGMENTS",
    "VideoAdAuthoringError",
    "assert_distinct_concepts",
    "build_script",
    "build_segment",
    "build_video_brief",
    "build_video_concept",
    "normalize_angles",
    "validate_voiceover_text",
]
