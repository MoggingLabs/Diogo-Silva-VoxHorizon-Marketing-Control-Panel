"""Creative QA engine (P2.2, #340) — deterministic checks + vision adjudication.

This is **Layer 3** of the pipeline rebuild (compliance + QA). It is a *pure,
importable* module: no network, no Supabase, no FastAPI. The qa_run endpoint
(P2 wiring, owned elsewhere) calls :func:`evaluate` with the decoded image
bytes, a small :class:`QAContext`, and the operator/sub-agent's *candidate*
vision findings, and persists the verdict. The engine never trusts the operator
to write a pass: it runs its own deterministic backstops (Pillow) and
*adjudicates* the supplied vision candidates against versioned thresholds.

Design mirrors ``PIPELINE-REBUILD-ARCHITECTURE.md`` Layer 3:

* **Deterministic checks** (this module owns them): decode the bytes, assert a
  minimum resolution per aspect ratio, a valid format (PNG/JPEG), a file-size
  sanity band, and — when an overlay region is supplied — a contrast/legibility
  heuristic for that region.
* **Rubric as data** — the defect classes (``hands``, ``text_glyphs``,
  ``anatomy``, ``surface_artifact``) plus a vertical-aware roofing sub-rubric,
  seeded from the donor ``creative-qa`` skill + ``roofing-image-detail-qa.md``.
  Every rubric item carries ``{check_id, version, defect_class,
  applies_to_vertical, engine, severity, pass_threshold}``.
* **Adjudication** — :func:`evaluate` runs the deterministic checks itself and
  scores operator-supplied ``vision_candidates`` against each rubric item's
  threshold. A failing deterministic check *or* a failing vision check makes the
  creative ``fail`` (routes to a targeted re-render). An *uncertain* vision
  result (missing candidate, label ``uncertain``, or a score below the
  threshold but above a hard-fail floor) never auto-passes — it escalates to
  ``needs_review``.

The roofing rubric is the *standard* the operator applies; the worker's
deterministic backstops run on top of (not instead of) the vision rubric.
"""

from __future__ import annotations

import io
from dataclasses import dataclass, field
from typing import Any, Literal

from PIL import Image, UnidentifiedImageError

from . import gate_core


# ===========================================================================
# Types
# ===========================================================================

Status = Literal["pass", "fail", "needs_review"]
Engine = Literal["deterministic", "vision"]
Severity = Literal["critical", "major", "minor"]
DefectClass = Literal["hands", "text_glyphs", "anatomy", "surface_artifact"]


# Aspect ratios the pipeline targets and their minimum shippable dimensions.
# Keys mirror the architecture's ``ratio`` enum (1:1, 9:16, 4:5 / 4x5, 16:9,
# 1.91:1 / 1.91x1). Both ``:`` and ``x`` spellings resolve to the same spec so
# callers can pass either the human label or the enum value.
#
# Minimums follow Meta's recommended feed/story/reel rails:
#   1:1   → 1080x1080   (feed square)
#   4:5   → 1080x1350   (feed portrait)
#   9:16  → 1080x1920   (story / reel)
#   16:9  → 1920x1080   (landscape)
#   1.91:1→ 1080x566    (link/landscape card; 1.91 ≈ 1080/566)
_RATIO_MIN_DIMS: dict[str, tuple[int, int]] = {
    "1:1": (1080, 1080),
    "4:5": (1080, 1350),
    "9:16": (1080, 1920),
    "16:9": (1920, 1080),
    "1.91:1": (1080, 566),
}

# Accept the architecture's ``x`` enum spellings as aliases of the ``:`` labels.
_RATIO_ALIASES: dict[str, str] = {
    "1x1": "1:1",
    "4x5": "4:5",
    "9x16": "9:16",
    "16x9": "16:9",
    "1.91x1": "1.91:1",
}

# Formats we will ship. Pillow reports e.g. "PNG"/"JPEG"/"WEBP"; we ship only
# PNG and JPEG creatives (Meta accepts both; WEBP/GIF/etc. are rejected here).
_ALLOWED_FORMATS: frozenset[str] = frozenset({"PNG", "JPEG"})

# File-size sanity band (bytes). A few-hundred-byte "image" is almost always a
# truncated/placeholder render; a >15 MB file is past Meta's image ceiling.
_MIN_BYTES = 1_024
_MAX_BYTES = 15 * 1_024 * 1_024

# Overlay legibility: an offer stamp / CTA must hold enough luminance contrast
# against the region it sits on to read at thumbnail size. We use a simple
# Michelson-style contrast on the region's luminance spread (0..1).
_MIN_OVERLAY_CONTRAST = 0.30

# Vision adjudication floors. A candidate scoring at/above the rubric item's
# ``pass_threshold`` passes; at/below ``_VISION_HARD_FAIL_FLOOR`` it is a hard
# fail; in between (or absent / labelled ``uncertain``) it escalates to review.
_VISION_HARD_FAIL_FLOOR = 0.40


def _normalise_ratio(ratio: str) -> str:
    """Map a caller-supplied ratio label/enum to a canonical ``:`` key."""
    key = ratio.strip().lower()
    key = _RATIO_ALIASES.get(key, key)
    return key


# ===========================================================================
# Rubric (data)
# ===========================================================================


@dataclass(frozen=True)
class RubricItem:
    """One versioned QA rule.

    ``engine`` is ``deterministic`` (the worker computes it from the bytes) or
    ``vision`` (a candidate finding is adjudicated against ``pass_threshold``).
    ``applies_to_vertical`` is ``"*"`` (every vertical) or a specific vertical
    such as ``"roofing"``. ``pass_threshold`` is the minimum vision score in
    ``[0, 1]`` that counts as a pass; it is ``None`` for deterministic items.
    """

    check_id: str
    version: str
    defect_class: DefectClass
    applies_to_vertical: str
    engine: Engine
    severity: Severity
    pass_threshold: float | None = None
    description: str = ""


# Rubric version — bump on any item change so persisted ``qa_result`` rows pin
# the ruleset they were scored against (append-only evidence, per Layer 2).
RUBRIC_VERSION = "2026.05.1"


# Seeded from ``ekko-skills/creative-qa/SKILL.md`` (the per-defect-class table)
# and ``references/roofing-image-detail-qa.md`` (the roofing sub-rubric).
RUBRIC: tuple[RubricItem, ...] = (
    # --- Deterministic backstops (worker-computed) -------------------------
    RubricItem(
        check_id="det.resolution",
        version=RUBRIC_VERSION,
        defect_class="surface_artifact",
        applies_to_vertical="*",
        engine="deterministic",
        severity="critical",
        description="Decoded dimensions meet the per-ratio shippable minimum.",
    ),
    RubricItem(
        check_id="det.format",
        version=RUBRIC_VERSION,
        defect_class="surface_artifact",
        applies_to_vertical="*",
        engine="deterministic",
        severity="critical",
        description="Image decodes as an allowed format (PNG or JPEG).",
    ),
    RubricItem(
        check_id="det.file_size",
        version=RUBRIC_VERSION,
        defect_class="surface_artifact",
        applies_to_vertical="*",
        engine="deterministic",
        severity="major",
        description="Byte size is within the sane band (not truncated, not oversized).",
    ),
    RubricItem(
        check_id="det.overlay_legibility",
        version=RUBRIC_VERSION,
        defect_class="text_glyphs",
        applies_to_vertical="*",
        engine="deterministic",
        severity="major",
        description="Any supplied overlay region holds enough contrast to read at thumbnail size.",
    ),
    # --- Vision defect classes (operator/sub-agent candidates) -------------
    RubricItem(
        check_id="vision.hands",
        version=RUBRIC_VERSION,
        defect_class="hands",
        applies_to_vertical="*",
        engine="vision",
        severity="critical",
        pass_threshold=0.70,
        description="Correct finger count, natural pose; no warped/extra/fused fingers.",
    ),
    RubricItem(
        check_id="vision.text_glyphs",
        version=RUBRIC_VERSION,
        defect_class="text_glyphs",
        applies_to_vertical="*",
        engine="vision",
        severity="major",
        pass_threshold=0.70,
        description="No garbled/misspelled baked-in text; any offer stamp is short and legible.",
    ),
    RubricItem(
        check_id="vision.anatomy",
        version=RUBRIC_VERSION,
        defect_class="anatomy",
        applies_to_vertical="*",
        engine="vision",
        severity="critical",
        pass_threshold=0.70,
        description="Faces, eyes, teeth, limbs natural; no plastic/waxy skin or uncanny smile.",
    ),
    RubricItem(
        check_id="vision.surface_artifact",
        version=RUBRIC_VERSION,
        defect_class="surface_artifact",
        applies_to_vertical="*",
        engine="vision",
        severity="major",
        pass_threshold=0.70,
        description="The service surface is believable; no melted/smeared/tiled artifacts.",
    ),
    # --- Roofing sub-rubric (applies_to_vertical == "roofing") ------------
    # From roofing-image-detail-qa.md: visible shingle rows, granule texture,
    # straight rooflines, real flashing, no melted surfaces. These are vision
    # checks under the ``surface_artifact`` class but vertical-scoped so a
    # non-roofing creative is never failed for a missing shingle candidate.
    RubricItem(
        check_id="vision.roofing.shingle_rows",
        version=RUBRIC_VERSION,
        defect_class="surface_artifact",
        applies_to_vertical="roofing",
        engine="vision",
        severity="major",
        pass_threshold=0.70,
        description="Visible individual shingle rows; not a smooth/tiled roof plane.",
    ),
    RubricItem(
        check_id="vision.roofing.granule_texture",
        version=RUBRIC_VERSION,
        defect_class="surface_artifact",
        applies_to_vertical="roofing",
        engine="vision",
        severity="major",
        pass_threshold=0.70,
        description="Dimensional asphalt texture / granule variation; not plastic-smooth.",
    ),
    RubricItem(
        check_id="vision.roofing.straight_rooflines",
        version=RUBRIC_VERSION,
        defect_class="surface_artifact",
        applies_to_vertical="roofing",
        engine="vision",
        severity="major",
        pass_threshold=0.70,
        description="Straight rooflines, gutters, fascia; no warped/sagging perspective.",
    ),
    RubricItem(
        check_id="vision.roofing.flashing",
        version=RUBRIC_VERSION,
        defect_class="surface_artifact",
        applies_to_vertical="roofing",
        engine="vision",
        severity="minor",
        pass_threshold=0.70,
        description="Clean, real flashing around chimney/dormers/valleys.",
    ),
    RubricItem(
        check_id="vision.roofing.no_melted_surface",
        version=RUBRIC_VERSION,
        defect_class="surface_artifact",
        applies_to_vertical="roofing",
        engine="vision",
        severity="major",
        pass_threshold=0.70,
        description="No melted, blurred, tiled, or overly smooth roof surface.",
    ),
)


def rubric_for_vertical(vertical: str | None) -> tuple[RubricItem, ...]:
    """Return the rubric items that apply to ``vertical``.

    Always includes the ``"*"`` (universal) items; adds the vertical-scoped
    items (e.g. roofing) only when ``vertical`` matches. Matching is
    case-insensitive on the trimmed vertical name.
    """
    norm = (vertical or "").strip().lower()
    return tuple(
        item
        for item in RUBRIC
        if item.applies_to_vertical == "*" or item.applies_to_vertical == norm
    )


# ===========================================================================
# Context / region / result shapes
# ===========================================================================


@dataclass(frozen=True)
class OverlayRegion:
    """A rectangular overlay region (offer stamp / CTA) in pixel coordinates.

    Coordinates are clamped to the image bounds at evaluation time, so a region
    that runs slightly past an edge is still checked over its visible part.
    """

    x: int
    y: int
    width: int
    height: int


@dataclass(frozen=True)
class QAContext:
    """Per-creative context the engine needs to pick the right rules.

    ``ratio`` selects the resolution minimum; ``vertical`` selects the
    vision sub-rubric (e.g. ``"roofing"``); ``overlay_region`` (optional)
    triggers the legibility check.
    """

    ratio: str = "1:1"
    vertical: str | None = None
    overlay_region: OverlayRegion | None = None


@dataclass(frozen=True)
class CheckResult:
    """The outcome of one rubric item against one creative."""

    check_id: str
    engine: Engine
    defect_class: DefectClass
    severity: Severity
    status: Status
    detail: str
    score: float | None = None
    threshold: float | None = None


@dataclass(frozen=True)
class Defect:
    """A specific named defect, ready to drive a targeted re-render."""

    check_id: str
    defect_class: DefectClass
    severity: Severity
    detail: str


@dataclass(frozen=True)
class QAReport:
    """The engine's verdict for one creative.

    ``status`` is the rolled-up verdict; ``checks`` is every rubric item that
    ran; ``defects`` is the failing/uncertain subset (the actionable list);
    ``rerender_recommended`` is true whenever any check hard-failed.
    """

    status: Status
    checks: list[CheckResult] = field(default_factory=list)
    defects: list[Defect] = field(default_factory=list)
    rerender_recommended: bool = False
    rubric_version: str = RUBRIC_VERSION

    def to_dict(self) -> dict[str, Any]:
        """JSON-serialisable form for persistence in ``qa_result``."""
        return {
            "status": self.status,
            "rubric_version": self.rubric_version,
            "rerender_recommended": self.rerender_recommended,
            "checks": [
                {
                    "check_id": c.check_id,
                    "engine": c.engine,
                    "defect_class": c.defect_class,
                    "severity": c.severity,
                    "status": c.status,
                    "detail": c.detail,
                    "score": c.score,
                    "threshold": c.threshold,
                }
                for c in self.checks
            ],
            "defects": [
                {
                    "check_id": d.check_id,
                    "defect_class": d.defect_class,
                    "severity": d.severity,
                    "detail": d.detail,
                }
                for d in self.defects
            ],
        }


# ===========================================================================
# Deterministic checks (Pillow, no network)
# ===========================================================================


class _DecodedImage:
    """A decoded image plus the cheap stats the checks need."""

    def __init__(self, img: Image.Image, byte_len: int) -> None:
        self.width, self.height = img.size
        self.format = (img.format or "").upper()
        self.byte_len = byte_len
        # Keep a luminance copy for the overlay-contrast heuristic. ``L`` mode
        # is a single-channel 8-bit luminance; cheap and deterministic.
        self._luma = img.convert("L")

    def region_contrast(self, region: OverlayRegion) -> float | None:
        """Michelson contrast (0..1) of the luminance inside ``region``.

        Returns ``None`` when the clamped region is empty (off-image). The
        heuristic stands in for "can a viewer read overlay text here": a flat
        region (text baked onto a uniform fill with no contrasting plate) reads
        near 0; a region spanning dark text on a light plate reads high.
        """
        x0 = max(0, region.x)
        y0 = max(0, region.y)
        x1 = min(self.width, region.x + region.width)
        y1 = min(self.height, region.y + region.height)
        if x1 <= x0 or y1 <= y0:
            return None
        crop = self._luma.crop((x0, y0, x1, y1))
        lo, hi = crop.getextrema()
        if hi + lo == 0:
            return 0.0
        return (hi - lo) / (hi + lo)


def decode_image(image_bytes: bytes) -> _DecodedImage | None:
    """Decode ``image_bytes`` with Pillow; ``None`` if it isn't a valid image."""
    if not image_bytes:
        return None
    try:
        img = Image.open(io.BytesIO(image_bytes))
        img.load()
    except (UnidentifiedImageError, OSError, ValueError):
        return None
    return _DecodedImage(img, len(image_bytes))


def _result(
    item: RubricItem, status: Status, detail: str, *, score: float | None = None
) -> CheckResult:
    return CheckResult(
        check_id=item.check_id,
        engine=item.engine,
        defect_class=item.defect_class,
        severity=item.severity,
        status=status,
        detail=detail,
        score=score,
        threshold=item.pass_threshold,
    )


def _item(check_id: str) -> RubricItem:
    for it in RUBRIC:
        if it.check_id == check_id:
            return it
    raise KeyError(check_id)  # pragma: no cover - guards a programming error


def run_deterministic_checks(
    image_bytes: bytes, context: QAContext
) -> list[CheckResult]:
    """Run every deterministic rubric item against the decoded bytes.

    Order: format → resolution → file-size → overlay legibility. When the bytes
    don't decode at all, the format check fails and the dimension/legibility
    checks fail in turn (we can't measure what we can't decode); file-size is
    still meaningful and is reported on its own.
    """
    fmt_item = _item("det.format")
    res_item = _item("det.resolution")
    size_item = _item("det.file_size")
    overlay_item = _item("det.overlay_legibility")

    results: list[CheckResult] = []
    decoded = decode_image(image_bytes)

    # --- format ---
    if decoded is None:
        results.append(
            _result(fmt_item, "fail", "Bytes did not decode as a valid image.")
        )
    elif decoded.format not in _ALLOWED_FORMATS:
        results.append(
            _result(
                fmt_item,
                "fail",
                f"Format {decoded.format or 'unknown'} is not shippable "
                f"(allowed: {', '.join(sorted(_ALLOWED_FORMATS))}).",
            )
        )
    else:
        results.append(_result(fmt_item, "pass", f"Format {decoded.format} OK."))

    # --- resolution (per ratio) ---
    ratio_key = _normalise_ratio(context.ratio)
    min_dims = _RATIO_MIN_DIMS.get(ratio_key)
    if decoded is None:
        results.append(
            _result(res_item, "fail", "Cannot measure dimensions of an undecodable image.")
        )
    elif min_dims is None:
        # Unknown ratio: don't silently pass. Escalate for a human to confirm
        # the placement; never auto-pass an unmeasurable rail.
        results.append(
            _result(
                res_item,
                "needs_review",
                f"Unknown ratio {context.ratio!r}; cannot apply a resolution minimum.",
            )
        )
    else:
        min_w, min_h = min_dims
        if decoded.width >= min_w and decoded.height >= min_h:
            results.append(
                _result(
                    res_item,
                    "pass",
                    f"{decoded.width}x{decoded.height} meets {ratio_key} minimum "
                    f"{min_w}x{min_h}.",
                )
            )
        else:
            results.append(
                _result(
                    res_item,
                    "fail",
                    f"{decoded.width}x{decoded.height} is below the {ratio_key} "
                    f"minimum {min_w}x{min_h}.",
                )
            )

    # --- file size ---
    byte_len = decoded.byte_len if decoded is not None else len(image_bytes)
    if byte_len < _MIN_BYTES:
        results.append(
            _result(
                size_item,
                "fail",
                f"{byte_len} bytes is below the {_MIN_BYTES}-byte floor "
                "(truncated/placeholder render?).",
            )
        )
    elif byte_len > _MAX_BYTES:
        results.append(
            _result(
                size_item,
                "fail",
                f"{byte_len} bytes exceeds the {_MAX_BYTES}-byte ceiling.",
            )
        )
    else:
        results.append(_result(size_item, "pass", f"{byte_len} bytes within band."))

    # --- overlay legibility (only when a region is supplied) ---
    if context.overlay_region is not None:
        if decoded is None:
            results.append(
                _result(
                    overlay_item,
                    "fail",
                    "Cannot measure overlay contrast of an undecodable image.",
                )
            )
        else:
            contrast = decoded.region_contrast(context.overlay_region)
            if contrast is None:
                results.append(
                    _result(
                        overlay_item,
                        "needs_review",
                        "Overlay region falls entirely outside the image bounds.",
                        score=None,
                    )
                )
            elif contrast >= _MIN_OVERLAY_CONTRAST:
                results.append(
                    _result(
                        overlay_item,
                        "pass",
                        f"Overlay contrast {contrast:.2f} >= {_MIN_OVERLAY_CONTRAST:.2f}.",
                        score=round(contrast, 4),
                    )
                )
            else:
                results.append(
                    _result(
                        overlay_item,
                        "fail",
                        f"Overlay contrast {contrast:.2f} below the "
                        f"{_MIN_OVERLAY_CONTRAST:.2f} legibility floor; "
                        "text will not read at thumbnail size.",
                        score=round(contrast, 4),
                    )
                )

    return results


# ===========================================================================
# Vision adjudication
# ===========================================================================


def _coerce_candidate_score(candidate: dict[str, Any]) -> float | None:
    """Resolve a candidate to a numeric score in ``[0, 1]``.

    Accepts an explicit ``score`` (float-like) or a ``label`` in
    ``{pass, fail, uncertain}``. ``pass`` → 1.0, ``fail`` → 0.0, ``uncertain``
    → ``None`` (escalate). A malformed/missing score also resolves to ``None``.
    """
    if "score" in candidate and candidate["score"] is not None:
        try:
            score = float(candidate["score"])
        except (TypeError, ValueError):
            return None
        # Clamp into range rather than reject — operators may send 0..100.
        if score > 1.0:
            score = score / 100.0
        return gate_core.clamp_unit(score)

    label = candidate.get("label")
    if isinstance(label, str):
        key = label.strip().lower()
        if key in ("pass", "ok", "clean"):
            return 1.0
        if key in ("fail", "defect", "reject"):
            return 0.0
        # "uncertain" / "review" / anything else → escalate.
    return None


def _adjudicate_vision(
    item: RubricItem, candidate: dict[str, Any] | None
) -> CheckResult:
    """Score one vision rubric item against its (optional) candidate.

    The worker is the adjudicator: it never lets an operator write a pass. The
    score band is applied by :func:`gate_core.adjudicate_score`; this function
    resolves the candidate to a score and dresses the verdict with the QA detail
    strings. Decision table (``t`` = ``pass_threshold``):

      * no candidate                       → needs_review (nothing observed)
      * label/score → ``None`` (uncertain) → needs_review
      * score >= t                         → pass
      * score <= hard-fail floor           → fail
      * floor < score < t                  → needs_review
    """
    threshold = item.pass_threshold if item.pass_threshold is not None else 0.70

    if candidate is None:
        return _result(
            item,
            "needs_review",
            "No vision candidate supplied for this rule; cannot auto-pass.",
        )

    note = str(candidate.get("note") or "").strip()
    score = _coerce_candidate_score(candidate)

    verdict = gate_core.adjudicate_score(
        score, threshold=threshold, hard_fail_floor=_VISION_HARD_FAIL_FLOOR
    )

    if score is None:
        detail = "Vision candidate is uncertain; escalating to review."
        if note:
            detail = f"{detail} ({note})"
        return _result(item, "needs_review", detail)

    detail_suffix = f" — {note}" if note else ""
    if verdict == "pass":
        return _result(
            item,
            "pass",
            f"Vision score {score:.2f} >= threshold {threshold:.2f}.{detail_suffix}",
            score=score,
        )
    if verdict == "fail":
        return _result(
            item,
            "fail",
            f"Vision score {score:.2f} <= hard-fail floor "
            f"{_VISION_HARD_FAIL_FLOOR:.2f}.{detail_suffix}",
            score=score,
        )
    return _result(
        item,
        "needs_review",
        f"Vision score {score:.2f} below threshold {threshold:.2f} but above "
        f"the hard-fail floor; escalating rather than auto-passing."
        f"{detail_suffix}",
        score=score,
    )


def run_vision_checks(
    context: QAContext, vision_candidates: list[dict[str, Any]] | None
) -> list[CheckResult]:
    """Adjudicate the supplied vision candidates against the applicable rubric.

    Only vision rubric items for ``context.vertical`` are scored. Candidates
    are matched by ``check_id``; a vision item with no matching candidate
    escalates to ``needs_review`` (the worker never auto-passes an unobserved
    defect class). Candidates whose ``check_id`` is unknown / out-of-scope are
    ignored (a roofing candidate on a non-roofing creative, say).
    """
    by_id: dict[str, dict[str, Any]] = {}
    for cand in vision_candidates or []:
        cid = cand.get("check_id")
        if isinstance(cid, str):
            by_id[cid] = cand

    results: list[CheckResult] = []
    for item in rubric_for_vertical(context.vertical):
        if item.engine != "vision":
            continue
        results.append(_adjudicate_vision(item, by_id.get(item.check_id)))
    return results


# ===========================================================================
# Adjudication entry point
# ===========================================================================


def _rollup_status(checks: list[CheckResult]) -> Status:
    """Roll a list of per-check statuses into a single verdict.

    Any ``fail`` ⇒ ``fail`` (routes to re-render). Otherwise any
    ``needs_review`` ⇒ ``needs_review`` (manager queue). Only an all-``pass``
    set ⇒ ``pass``. Never auto-pass on an uncertain result. This is the shared
    rollup with no severity gate (every fail blocks).
    """
    return gate_core.rollup(checks, verdict_of=lambda c: c.status)


def evaluate(
    image_bytes: bytes,
    context: QAContext | None = None,
    vision_candidates: list[dict[str, Any]] | None = None,
) -> QAReport:
    """Adjudicate one creative and return its QA verdict.

    The engine runs the deterministic checks itself (it never trusts a caller's
    deterministic claims) and adjudicates the operator-supplied
    ``vision_candidates`` (``[{check_id, score|label, note}]``) against the
    versioned rubric thresholds.

    Returns a :class:`QAReport`:

      * ``status``                — ``pass`` | ``fail`` | ``needs_review``.
      * ``checks``                — every rubric item that ran.
      * ``defects``               — the failing/uncertain subset (actionable).
      * ``rerender_recommended``  — true iff any check hard-failed.

    A failing deterministic check *or* a failing vision check ⇒ ``fail`` ⇒
    re-render. An uncertain vision result (missing candidate, ``uncertain``
    label, or a mid-band score) never auto-passes — it escalates to
    ``needs_review``.
    """
    ctx = context or QAContext()

    checks: list[CheckResult] = []
    checks.extend(run_deterministic_checks(image_bytes, ctx))
    checks.extend(run_vision_checks(ctx, vision_candidates))

    status = _rollup_status(checks)
    rerender = any(c.status == "fail" for c in checks)

    defects = [
        Defect(
            check_id=c.check_id,
            defect_class=c.defect_class,
            severity=c.severity,
            detail=c.detail,
        )
        for c in checks
        if c.status in ("fail", "needs_review")
    ]

    return QAReport(
        status=status,
        checks=checks,
        defects=defects,
        rerender_recommended=rerender,
        rubric_version=RUBRIC_VERSION,
    )
