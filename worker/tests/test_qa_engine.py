"""Tests for the creative QA engine (P2.2, #340).

Pure-logic coverage of :mod:`src.services.qa_engine`:

* deterministic checks (resolution per ratio, format, file size, overlay
  legibility) against fixture images generated in-test with Pillow;
* the rubric-as-data shape (versioned items, vertical scoping);
* vision-candidate adjudication (pass / fail / escalate, label + score forms,
  the never-auto-pass-on-uncertain rule);
* the :func:`evaluate` rollup (any fail ⇒ fail+rerender; uncertain ⇒
  needs_review; all-pass ⇒ pass) and the serialised report shape.
"""

from __future__ import annotations

import io

import pytest
from PIL import Image

from src.services import qa_engine as qa
from src.services.qa_engine import (
    RUBRIC,
    RUBRIC_VERSION,
    OverlayRegion,
    QAContext,
    QAReport,
    RubricItem,
    decode_image,
    evaluate,
    rubric_for_vertical,
    run_deterministic_checks,
    run_vision_checks,
)


# ===========================================================================
# Fixture-image helpers (generated in-test with Pillow)
# ===========================================================================


def _png_bytes(width: int, height: int, color=(120, 120, 120)) -> bytes:
    """A solid-color RGB PNG of the given size."""
    img = Image.new("RGB", (width, height), color)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def _jpeg_bytes(width: int, height: int, color=(120, 120, 120)) -> bytes:
    img = Image.new("RGB", (width, height), color)
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=90)
    return buf.getvalue()


def _webp_bytes(width: int, height: int) -> bytes:
    img = Image.new("RGB", (width, height), (10, 20, 30))
    buf = io.BytesIO()
    img.save(buf, format="WEBP")
    return buf.getvalue()


def _png_with_overlay_plate(
    width: int,
    height: int,
    region: OverlayRegion,
    *,
    base=(255, 255, 255),
    plate=(0, 0, 0),
) -> bytes:
    """A base-color PNG with a contrasting filled rectangle in ``region``."""
    img = Image.new("RGB", (width, height), base)
    for x in range(max(0, region.x), min(width, region.x + region.width)):
        for y in range(max(0, region.y), min(height, region.y + region.height)):
            img.putpixel((x, y), plate)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def _check(results, check_id):
    """Return the single CheckResult with ``check_id`` (or raise)."""
    for r in results:
        if r.check_id == check_id:
            return r
    raise AssertionError(f"no check {check_id} in {[r.check_id for r in results]}")


# ===========================================================================
# decode_image
# ===========================================================================


def test_decode_valid_png() -> None:
    decoded = decode_image(_png_bytes(1080, 1080))
    assert decoded is not None
    assert decoded.width == 1080 and decoded.height == 1080
    assert decoded.format == "PNG"


def test_decode_valid_jpeg() -> None:
    decoded = decode_image(_jpeg_bytes(1080, 1080))
    assert decoded is not None
    assert decoded.format == "JPEG"


def test_decode_empty_bytes_returns_none() -> None:
    assert decode_image(b"") is None


def test_decode_garbage_returns_none() -> None:
    assert decode_image(b"not an image at all, just text") is None


# ===========================================================================
# Rubric (data)
# ===========================================================================


def test_every_rubric_item_is_well_formed() -> None:
    for item in RUBRIC:
        assert isinstance(item, RubricItem)
        assert item.check_id
        assert item.version == RUBRIC_VERSION
        assert item.defect_class in (
            "hands",
            "text_glyphs",
            "anatomy",
            "surface_artifact",
        )
        assert item.engine in ("deterministic", "vision")
        assert item.severity in ("critical", "major", "minor")
        if item.engine == "vision":
            assert item.pass_threshold is not None
            assert 0.0 < item.pass_threshold <= 1.0
        else:
            assert item.pass_threshold is None


def test_rubric_check_ids_are_unique() -> None:
    ids = [i.check_id for i in RUBRIC]
    assert len(ids) == len(set(ids))


def test_rubric_for_vertical_excludes_roofing_by_default() -> None:
    items = rubric_for_vertical(None)
    assert all(i.applies_to_vertical == "*" for i in items)
    assert not any("roofing" in i.check_id for i in items)


def test_rubric_for_vertical_includes_roofing_subrubric() -> None:
    items = rubric_for_vertical("roofing")
    roofing_ids = {i.check_id for i in items if i.applies_to_vertical == "roofing"}
    # Seeded from roofing-image-detail-qa.md.
    assert "vision.roofing.shingle_rows" in roofing_ids
    assert "vision.roofing.granule_texture" in roofing_ids
    assert "vision.roofing.straight_rooflines" in roofing_ids
    assert "vision.roofing.flashing" in roofing_ids
    assert "vision.roofing.no_melted_surface" in roofing_ids


def test_rubric_for_vertical_is_case_insensitive() -> None:
    items = rubric_for_vertical("  ROOFING ")
    assert any(i.applies_to_vertical == "roofing" for i in items)


def test_rubric_for_unknown_vertical_is_universal_only() -> None:
    items = rubric_for_vertical("plumbing")
    assert all(i.applies_to_vertical == "*" for i in items)


# ===========================================================================
# Deterministic: resolution per ratio
# ===========================================================================


@pytest.mark.parametrize(
    ("ratio", "w", "h"),
    [
        ("1:1", 1080, 1080),
        ("4:5", 1080, 1350),
        ("9:16", 1080, 1920),
        ("16:9", 1920, 1080),
        ("1.91:1", 1080, 566),
    ],
)
def test_resolution_passes_at_minimum(ratio: str, w: int, h: int) -> None:
    results = run_deterministic_checks(_png_bytes(w, h), QAContext(ratio=ratio))
    assert _check(results, "det.resolution").status == "pass"


@pytest.mark.parametrize(
    ("ratio", "w", "h"),
    [
        ("1:1", 1079, 1080),
        ("4:5", 1080, 1349),
        ("9:16", 1080, 1919),
        ("16:9", 1919, 1080),
        ("1.91:1", 1079, 566),
    ],
)
def test_resolution_fails_below_minimum(ratio: str, w: int, h: int) -> None:
    results = run_deterministic_checks(_png_bytes(w, h), QAContext(ratio=ratio))
    res = _check(results, "det.resolution")
    assert res.status == "fail"
    assert "below" in res.detail


def test_ratio_x_spelling_alias_is_accepted() -> None:
    # 4x5 enum spelling resolves to the 4:5 minimum.
    results = run_deterministic_checks(_png_bytes(1080, 1350), QAContext(ratio="4x5"))
    assert _check(results, "det.resolution").status == "pass"


def test_unknown_ratio_escalates_resolution() -> None:
    results = run_deterministic_checks(_png_bytes(1080, 1080), QAContext(ratio="3:2"))
    res = _check(results, "det.resolution")
    assert res.status == "needs_review"
    assert "Unknown ratio" in res.detail


# ===========================================================================
# Deterministic: format
# ===========================================================================


def test_format_png_passes() -> None:
    results = run_deterministic_checks(_png_bytes(1080, 1080), QAContext())
    assert _check(results, "det.format").status == "pass"


def test_format_jpeg_passes() -> None:
    results = run_deterministic_checks(_jpeg_bytes(1080, 1080), QAContext())
    assert _check(results, "det.format").status == "pass"


def test_format_webp_fails() -> None:
    results = run_deterministic_checks(_webp_bytes(1080, 1080), QAContext())
    fmt = _check(results, "det.format")
    assert fmt.status == "fail"
    assert "not shippable" in fmt.detail


def test_undecodable_fails_format_and_resolution() -> None:
    results = run_deterministic_checks(b"garbage-bytes", QAContext())
    assert _check(results, "det.format").status == "fail"
    assert _check(results, "det.resolution").status == "fail"


# ===========================================================================
# Deterministic: file size
# ===========================================================================


def test_file_size_within_band_passes() -> None:
    results = run_deterministic_checks(_png_bytes(1080, 1080), QAContext())
    assert _check(results, "det.file_size").status == "pass"


def test_file_size_too_small_fails() -> None:
    # A handful of bytes — below the 1 KiB floor — fails size even though it
    # also fails format/resolution.
    results = run_deterministic_checks(b"\x89PNG\r\n", QAContext())
    size = _check(results, "det.file_size")
    assert size.status == "fail"
    assert "floor" in size.detail


def test_file_size_too_large_fails(monkeypatch: pytest.MonkeyPatch) -> None:
    # Shrink the ceiling rather than build a 15 MB fixture.
    monkeypatch.setattr(qa, "_MAX_BYTES", 500)
    results = run_deterministic_checks(_png_bytes(1080, 1080), QAContext())
    size = _check(results, "det.file_size")
    assert size.status == "fail"
    assert "ceiling" in size.detail


# ===========================================================================
# Deterministic: overlay legibility
# ===========================================================================


def test_no_overlay_region_skips_legibility_check() -> None:
    results = run_deterministic_checks(_png_bytes(1080, 1080), QAContext())
    assert all(r.check_id != "det.overlay_legibility" for r in results)


def test_high_contrast_overlay_passes() -> None:
    # The measured region spans both the white base and a black plate inside it
    # (dark "text" on a light field), so luminance spread is maximal.
    region = OverlayRegion(x=100, y=100, width=400, height=200)
    plate = OverlayRegion(x=150, y=150, width=100, height=80)
    img = _png_with_overlay_plate(1080, 1080, plate)
    results = run_deterministic_checks(img, QAContext(overlay_region=region))
    leg = _check(results, "det.overlay_legibility")
    assert leg.status == "pass"
    assert leg.score is not None and leg.score >= qa._MIN_OVERLAY_CONTRAST


def test_flat_overlay_region_fails_legibility() -> None:
    # A uniform mid-grey region has no luminance spread → contrast 0.
    region = OverlayRegion(x=100, y=100, width=400, height=200)
    img = _png_bytes(1080, 1080, color=(120, 120, 120))
    results = run_deterministic_checks(img, QAContext(overlay_region=region))
    leg = _check(results, "det.overlay_legibility")
    assert leg.status == "fail"
    assert leg.score == 0.0


def test_pure_black_region_contrast_is_zero() -> None:
    # hi + lo == 0 branch: an all-black region.
    region = OverlayRegion(x=0, y=0, width=50, height=50)
    img = _png_bytes(100, 100, color=(0, 0, 0))
    results = run_deterministic_checks(img, QAContext(overlay_region=region))
    leg = _check(results, "det.overlay_legibility")
    assert leg.status == "fail"
    assert leg.score == 0.0


def test_off_image_overlay_region_escalates() -> None:
    region = OverlayRegion(x=5000, y=5000, width=100, height=100)
    img = _png_bytes(1080, 1080)
    results = run_deterministic_checks(img, QAContext(overlay_region=region))
    leg = _check(results, "det.overlay_legibility")
    assert leg.status == "needs_review"
    assert "outside the image" in leg.detail


def test_overlay_region_clamped_to_bounds() -> None:
    # Region runs past the right/bottom edge; its clamped visible part (900,900
    # → 1080,1080) spans both the white base and a smaller black plate, so it
    # still measures real contrast rather than crashing on the off-image span.
    plate = OverlayRegion(x=920, y=920, width=80, height=80)
    img = _png_with_overlay_plate(1080, 1080, plate)
    region = OverlayRegion(x=900, y=900, width=500, height=500)
    results = run_deterministic_checks(img, QAContext(overlay_region=region))
    leg = _check(results, "det.overlay_legibility")
    assert leg.status == "pass"


def test_overlay_legibility_on_undecodable_image_fails() -> None:
    region = OverlayRegion(x=0, y=0, width=10, height=10)
    results = run_deterministic_checks(b"nope", QAContext(overlay_region=region))
    leg = _check(results, "det.overlay_legibility")
    assert leg.status == "fail"
    assert "undecodable" in leg.detail


# ===========================================================================
# Vision adjudication
# ===========================================================================


def test_vision_pass_above_threshold() -> None:
    cands = [{"check_id": "vision.hands", "score": 0.95}]
    results = run_vision_checks(QAContext(), cands)
    assert _check(results, "vision.hands").status == "pass"


def test_vision_fail_at_hard_floor() -> None:
    cands = [{"check_id": "vision.hands", "score": 0.10}]
    results = run_vision_checks(QAContext(), cands)
    hands = _check(results, "vision.hands")
    assert hands.status == "fail"


def test_vision_midband_score_escalates_never_autopass() -> None:
    # Between the hard-fail floor (0.40) and the threshold (0.70).
    cands = [{"check_id": "vision.anatomy", "score": 0.55}]
    results = run_vision_checks(QAContext(), cands)
    anat = _check(results, "vision.anatomy")
    assert anat.status == "needs_review"


def test_vision_missing_candidate_escalates() -> None:
    # No candidate for vision.hands → cannot auto-pass.
    results = run_vision_checks(QAContext(), [])
    hands = _check(results, "vision.hands")
    assert hands.status == "needs_review"
    assert "No vision candidate" in hands.detail


def test_vision_uncertain_label_escalates() -> None:
    cands = [{"check_id": "vision.hands", "label": "uncertain", "note": "blurry"}]
    results = run_vision_checks(QAContext(), cands)
    hands = _check(results, "vision.hands")
    assert hands.status == "needs_review"
    assert "blurry" in hands.detail


def test_vision_pass_label_passes() -> None:
    cands = [{"check_id": "vision.hands", "label": "pass"}]
    results = run_vision_checks(QAContext(), cands)
    assert _check(results, "vision.hands").status == "pass"


def test_vision_fail_label_fails() -> None:
    cands = [{"check_id": "vision.text_glyphs", "label": "fail", "note": "garbled"}]
    results = run_vision_checks(QAContext(), cands)
    glyph = _check(results, "vision.text_glyphs")
    assert glyph.status == "fail"
    assert "garbled" in glyph.detail


def test_vision_score_on_0_100_scale_is_normalised() -> None:
    cands = [{"check_id": "vision.hands", "score": 92}]  # 92/100 → 0.92
    results = run_vision_checks(QAContext(), cands)
    hands = _check(results, "vision.hands")
    assert hands.status == "pass"
    assert hands.score == pytest.approx(0.92)


def test_vision_malformed_score_escalates() -> None:
    cands = [{"check_id": "vision.hands", "score": "not-a-number"}]
    results = run_vision_checks(QAContext(), cands)
    assert _check(results, "vision.hands").status == "needs_review"


def test_vision_unknown_label_escalates() -> None:
    cands = [{"check_id": "vision.hands", "label": "maybe"}]
    results = run_vision_checks(QAContext(), cands)
    assert _check(results, "vision.hands").status == "needs_review"


def test_vision_score_clamped_negative() -> None:
    cands = [{"check_id": "vision.hands", "score": -5}]
    results = run_vision_checks(QAContext(), cands)
    hands = _check(results, "vision.hands")
    assert hands.status == "fail"
    assert hands.score == 0.0


def test_vision_candidate_with_non_string_check_id_ignored() -> None:
    # A candidate whose check_id isn't a string is dropped; the rule then has
    # no candidate and escalates.
    cands = [{"check_id": 123, "score": 0.95}]
    results = run_vision_checks(QAContext(), cands)
    assert _check(results, "vision.hands").status == "needs_review"


def test_roofing_candidates_scored_only_for_roofing() -> None:
    cands = [{"check_id": "vision.roofing.shingle_rows", "score": 0.2}]
    # Non-roofing context: the roofing rule isn't in scope, so it isn't scored.
    non_roof = run_vision_checks(QAContext(vertical=None), cands)
    assert all(r.check_id != "vision.roofing.shingle_rows" for r in non_roof)
    # Roofing context: it is scored and fails.
    roof = run_vision_checks(QAContext(vertical="roofing"), cands)
    assert _check(roof, "vision.roofing.shingle_rows").status == "fail"


def test_vision_pass_note_appended() -> None:
    cands = [{"check_id": "vision.hands", "score": 0.99, "note": "clean pose"}]
    results = run_vision_checks(QAContext(), cands)
    assert "clean pose" in _check(results, "vision.hands").detail


def test_vision_none_candidate_list() -> None:
    # vision_candidates=None must behave like an empty list.
    results = run_vision_checks(QAContext(), None)
    assert _check(results, "vision.hands").status == "needs_review"


# ===========================================================================
# evaluate() — rollup + report
# ===========================================================================


def _all_pass_candidates(vertical: str | None = None):
    return [
        {"check_id": item.check_id, "score": 0.95}
        for item in rubric_for_vertical(vertical)
        if item.engine == "vision"
    ]


def test_evaluate_all_pass() -> None:
    img = _png_bytes(1080, 1080)
    report = evaluate(img, QAContext(ratio="1:1"), _all_pass_candidates())
    assert isinstance(report, QAReport)
    assert report.status == "pass"
    assert report.rerender_recommended is False
    assert report.defects == []
    assert report.rubric_version == RUBRIC_VERSION


def test_evaluate_undersized_fails_and_recommends_rerender() -> None:
    img = _png_bytes(800, 800)  # below 1:1 minimum
    report = evaluate(img, QAContext(ratio="1:1"), _all_pass_candidates())
    assert report.status == "fail"
    assert report.rerender_recommended is True
    assert any(d.check_id == "det.resolution" for d in report.defects)


def test_evaluate_failing_vision_check_fails() -> None:
    img = _png_bytes(1080, 1080)
    cands = _all_pass_candidates()
    # Force the hands candidate to a hard fail.
    cands = [
        {"check_id": "vision.hands", "score": 0.05}
        if c["check_id"] == "vision.hands"
        else c
        for c in cands
    ]
    report = evaluate(img, QAContext(ratio="1:1"), cands)
    assert report.status == "fail"
    assert report.rerender_recommended is True
    assert any(d.check_id == "vision.hands" for d in report.defects)


def test_evaluate_uncertain_vision_needs_review_not_pass() -> None:
    img = _png_bytes(1080, 1080)
    cands = _all_pass_candidates()
    cands = [
        {"check_id": "vision.anatomy", "label": "uncertain"}
        if c["check_id"] == "vision.anatomy"
        else c
        for c in cands
    ]
    report = evaluate(img, QAContext(ratio="1:1"), cands)
    assert report.status == "needs_review"
    # An uncertain (not failing) result must NOT trigger a re-render.
    assert report.rerender_recommended is False
    assert any(d.check_id == "vision.anatomy" for d in report.defects)


def test_evaluate_missing_all_vision_candidates_needs_review() -> None:
    img = _png_bytes(1080, 1080)
    report = evaluate(img, QAContext(ratio="1:1"), [])
    # Deterministic checks pass, but every vision rule escalates.
    assert report.status == "needs_review"
    assert report.rerender_recommended is False


def test_evaluate_fail_dominates_needs_review() -> None:
    # A fail and a needs_review together roll up to fail.
    img = _png_bytes(800, 800)  # resolution fail
    cands = []  # all vision → needs_review
    report = evaluate(img, QAContext(ratio="1:1"), cands)
    assert report.status == "fail"


def test_evaluate_roofing_includes_subrubric() -> None:
    img = _png_bytes(1080, 1080)
    cands = _all_pass_candidates(vertical="roofing")
    report = evaluate(img, QAContext(ratio="1:1", vertical="roofing"), cands)
    ran = {c.check_id for c in report.checks}
    assert "vision.roofing.shingle_rows" in ran
    assert report.status == "pass"


def test_evaluate_roofing_melted_surface_fails() -> None:
    img = _png_bytes(1080, 1080)
    cands = _all_pass_candidates(vertical="roofing")
    cands = [
        {"check_id": "vision.roofing.no_melted_surface", "score": 0.1}
        if c["check_id"] == "vision.roofing.no_melted_surface"
        else c
        for c in cands
    ]
    report = evaluate(img, QAContext(ratio="1:1", vertical="roofing"), cands)
    assert report.status == "fail"
    assert any(d.check_id == "vision.roofing.no_melted_surface" for d in report.defects)


def test_evaluate_defaults_when_no_context() -> None:
    # context=None → default 1:1, no vertical; a 1080x1080 with all-pass vision.
    img = _png_bytes(1080, 1080)
    report = evaluate(img, None, _all_pass_candidates())
    assert report.status == "pass"


def test_evaluate_overlay_legibility_failure_routes_to_fail() -> None:
    region = OverlayRegion(x=100, y=100, width=400, height=200)
    img = _png_bytes(1080, 1080, color=(120, 120, 120))  # flat overlay region
    report = evaluate(
        img,
        QAContext(ratio="1:1", overlay_region=region),
        _all_pass_candidates(),
    )
    assert report.status == "fail"
    assert any(d.check_id == "det.overlay_legibility" for d in report.defects)


def test_report_to_dict_is_json_shaped() -> None:
    img = _png_bytes(800, 800)
    report = evaluate(img, QAContext(ratio="1:1"), _all_pass_candidates())
    d = report.to_dict()
    assert d["status"] == "fail"
    assert d["rubric_version"] == RUBRIC_VERSION
    assert d["rerender_recommended"] is True
    assert isinstance(d["checks"], list) and d["checks"]
    assert isinstance(d["defects"], list) and d["defects"]
    # Each check entry carries the full evidence shape.
    sample = d["checks"][0]
    assert {
        "check_id",
        "engine",
        "defect_class",
        "severity",
        "status",
        "detail",
        "score",
        "threshold",
    } <= set(sample)
    # Each defect entry is the actionable subset.
    defect = d["defects"][0]
    assert {"check_id", "defect_class", "severity", "detail"} <= set(defect)


def test_evaluate_checks_include_both_engines() -> None:
    img = _png_bytes(1080, 1080)
    report = evaluate(img, QAContext(ratio="1:1"), _all_pass_candidates())
    engines = {c.engine for c in report.checks}
    assert engines == {"deterministic", "vision"}
