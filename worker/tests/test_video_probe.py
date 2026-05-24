"""Unit tests for the video probe parser + verdict evaluators (M3 #489 / #492).

Pure tests: no subprocess, no DB. They drive :func:`parse_probe` over
golden-style ffprobe JSON fixtures and the two verdict evaluators
(:func:`video_qa_verdict` / :func:`video_spec_verdict`) over the parsed facts,
asserting the worker-owned invariants:

  * a clean asset passes; a missing video/audio stream, a 0s duration, or a
    mismatched aspect ratio fails;
  * an unknown ratio escalates to ``needs_review`` (never auto-passes);
  * the spec verdict fails a wrong container / codec / dimensions / out-of-band
    duration, computed from the probed facts (no caller claim is trusted).
"""

from __future__ import annotations

from typing import Any

from src.services import video_probe


# ===========================================================================
# Golden-style ffprobe JSON fixtures
# ===========================================================================


def _probe_json(
    *,
    container: str = "mov,mp4,m4a,3gp,3g2,mj2",
    vcodec: str | None = "h264",
    acodec: str | None = "aac",
    width: int | None = 1080,
    height: int | None = 1920,
    duration: float | None = 18.5,
    fps: str | None = "30/1",
) -> dict[str, Any]:
    """A raw ffprobe ``-show_format -show_streams`` JSON for a 9:16 H.264 MP4."""
    streams: list[dict[str, Any]] = []
    if vcodec is not None:
        streams.append(
            {
                "codec_type": "video",
                "codec_name": vcodec,
                "width": width,
                "height": height,
                "avg_frame_rate": fps,
                "r_frame_rate": fps,
            }
        )
    if acodec is not None:
        streams.append({"codec_type": "audio", "codec_name": acodec})
    fmt: dict[str, Any] = {"format_name": container}
    if duration is not None:
        fmt["duration"] = str(duration)
    return {"format": fmt, "streams": streams}


# ===========================================================================
# parse_probe
# ===========================================================================


def test_parse_probe_extracts_all_facts() -> None:
    probe = video_probe.parse_probe(_probe_json())
    assert probe.container == "mov"
    assert probe.vcodec == "h264"
    assert probe.acodec == "aac"
    assert probe.width == 1080
    assert probe.height == 1920
    assert probe.duration_s == 18.5
    assert probe.has_video is True
    assert probe.has_audio is True
    assert probe.fps == 30.0
    assert abs(probe.aspect_ratio - (1080 / 1920)) < 1e-9


def test_parse_probe_no_audio_stream() -> None:
    probe = video_probe.parse_probe(_probe_json(acodec=None))
    assert probe.has_video is True
    assert probe.has_audio is False
    assert probe.acodec is None


def test_parse_probe_no_video_stream() -> None:
    probe = video_probe.parse_probe(_probe_json(vcodec=None))
    assert probe.has_video is False
    assert probe.vcodec is None
    assert probe.aspect_ratio is None


def test_parse_probe_duration_falls_back_to_video_stream() -> None:
    raw = _probe_json(duration=None)
    raw["streams"][0]["duration"] = "12.0"
    probe = video_probe.parse_probe(raw)
    assert probe.duration_s == 12.0


def test_parse_probe_empty_json_is_all_none() -> None:
    probe = video_probe.parse_probe({})
    assert probe.container is None
    assert probe.has_video is False
    assert probe.has_audio is False
    assert probe.duration_s is None
    assert probe.fps is None


def test_parse_probe_fps_from_fraction() -> None:
    probe = video_probe.parse_probe(_probe_json(fps="30000/1001"))
    assert probe.fps is not None
    assert abs(probe.fps - 29.97) < 0.01


def test_parse_probe_fps_zero_division_is_none() -> None:
    probe = video_probe.parse_probe(_probe_json(fps="0/0"))
    assert probe.fps is None


def test_parse_probe_to_dict_roundtrips() -> None:
    probe = video_probe.parse_probe(_probe_json())
    d = probe.to_dict()
    assert d["container"] == "mov"
    assert d["vcodec"] == "h264"
    assert d["has_audio"] is True


def test_build_probe_argv_is_json_format() -> None:
    argv = video_probe.build_probe_argv("/tmp/x.mp4", ffprobe_bin="ffprobe")
    assert argv[0] == "ffprobe"
    assert "json" in argv
    assert "-show_streams" in argv
    assert argv[-1] == "/tmp/x.mp4"


# ===========================================================================
# video_qa_verdict
# ===========================================================================


def test_qa_verdict_clean_9x16_passes() -> None:
    probe = video_probe.parse_probe(_probe_json())
    report = video_probe.video_qa_verdict(probe, ratio="9x16")
    assert report.status == "pass"
    assert report.passed is True
    assert report.ruleset_version == video_probe.VIDEO_QA_VERSION
    assert all(c.status == "pass" for c in report.checks)


def test_qa_verdict_missing_audio_fails() -> None:
    probe = video_probe.parse_probe(_probe_json(acodec=None))
    report = video_probe.video_qa_verdict(probe, ratio="9x16")
    assert report.status == "fail"
    ids = {c.check_id for c in report.checks if c.status == "fail"}
    assert "video.has_audio" in ids


def test_qa_verdict_missing_video_fails() -> None:
    probe = video_probe.parse_probe(_probe_json(vcodec=None))
    report = video_probe.video_qa_verdict(probe, ratio="9x16")
    assert report.status == "fail"
    ids = {c.check_id for c in report.checks if c.status == "fail"}
    assert "video.has_video" in ids
    assert "video.resolution" in ids


def test_qa_verdict_zero_duration_fails() -> None:
    probe = video_probe.parse_probe(_probe_json(duration=0.0))
    report = video_probe.video_qa_verdict(probe, ratio="9x16")
    assert report.status == "fail"
    assert any(
        c.check_id == "video.duration" and c.status == "fail" for c in report.checks
    )


def test_qa_verdict_wrong_ratio_fails() -> None:
    # A 1:1 asset sent to a 9:16 rail must fail the resolution check.
    probe = video_probe.parse_probe(_probe_json(width=1080, height=1080))
    report = video_probe.video_qa_verdict(probe, ratio="9x16")
    assert report.status == "fail"
    assert any(
        c.check_id == "video.resolution" and c.status == "fail" for c in report.checks
    )


def test_qa_verdict_unknown_ratio_needs_review() -> None:
    probe = video_probe.parse_probe(_probe_json())
    report = video_probe.video_qa_verdict(probe, ratio="banana")
    assert report.status == "needs_review"
    assert any(
        c.check_id == "video.resolution" and c.status == "needs_review"
        for c in report.checks
    )


def test_qa_verdict_tolerates_minor_dimension_drift() -> None:
    # 1088x1920 (a common mod-16 encode of 9:16) is within tolerance.
    probe = video_probe.parse_probe(_probe_json(width=1088, height=1920))
    report = video_probe.video_qa_verdict(probe, ratio="9x16")
    assert report.status == "pass"


# ===========================================================================
# video_spec_verdict
# ===========================================================================


def _reels_spec() -> video_probe.PlacementSpec:
    spec = video_probe.get_placement_spec("reels")
    assert spec is not None
    return spec


def test_spec_verdict_conformant_reel_passes() -> None:
    probe = video_probe.parse_probe(_probe_json())
    report = video_probe.video_spec_verdict(probe, _reels_spec())
    assert report.status == "pass"
    assert report.ruleset_version == video_probe.SPEC_RULESET_VERSION


def test_spec_verdict_wrong_container_fails() -> None:
    probe = video_probe.parse_probe(_probe_json(container="webm"))
    report = video_probe.video_spec_verdict(probe, _reels_spec())
    assert report.status == "fail"
    assert any(
        c.check_id == "spec.container" and c.status == "fail" for c in report.checks
    )


def test_spec_verdict_wrong_codec_fails() -> None:
    probe = video_probe.parse_probe(_probe_json(vcodec="vp9"))
    report = video_probe.video_spec_verdict(probe, _reels_spec())
    assert report.status == "fail"
    assert any(
        c.check_id == "spec.vcodec" and c.status == "fail" for c in report.checks
    )


def test_spec_verdict_wrong_dimensions_fails() -> None:
    probe = video_probe.parse_probe(_probe_json(width=1920, height=1080))
    report = video_probe.video_spec_verdict(probe, _reels_spec())
    assert report.status == "fail"
    assert any(
        c.check_id == "spec.dimensions" and c.status == "fail" for c in report.checks
    )


def test_spec_verdict_duration_too_long_fails() -> None:
    probe = video_probe.parse_probe(_probe_json(duration=120.0))
    report = video_probe.video_spec_verdict(probe, _reels_spec())
    assert report.status == "fail"
    assert any(
        c.check_id == "spec.duration" and c.status == "fail" for c in report.checks
    )


def test_spec_verdict_duration_too_short_fails() -> None:
    probe = video_probe.parse_probe(_probe_json(duration=1.0))
    report = video_probe.video_spec_verdict(probe, _reels_spec())
    assert report.status == "fail"


def test_spec_verdict_missing_audio_fails_when_required() -> None:
    probe = video_probe.parse_probe(_probe_json(acodec=None))
    report = video_probe.video_spec_verdict(probe, _reels_spec())
    assert report.status == "fail"
    assert any(
        c.check_id == "spec.audio" and c.status == "fail" for c in report.checks
    )


def test_spec_verdict_exact_dims_required_fails_on_mismatch() -> None:
    # A spec that pins exact width/height fails a same-ratio different-size asset.
    spec = video_probe.PlacementSpec(
        placement="custom",
        version="t",
        ratio="9:16",
        width=1080,
        height=1920,
    )
    probe = video_probe.parse_probe(_probe_json(width=720, height=1280))
    report = video_probe.video_spec_verdict(probe, spec)
    assert report.status == "fail"
    assert any(
        c.check_id == "spec.dimensions" and c.status == "fail" for c in report.checks
    )


def test_get_placement_spec_aliases() -> None:
    assert video_probe.get_placement_spec("reel") is video_probe.get_placement_spec(
        "reels"
    )
    assert video_probe.get_placement_spec("story").placement == "stories"
    assert video_probe.get_placement_spec("unknown") is None


def test_placement_specs_are_versioned() -> None:
    specs = video_probe.get_placement_specs()
    assert len(specs) >= 3
    assert all(s.version == video_probe.SPEC_RULESET_VERSION for s in specs)


# ===========================================================================
# Edge / defensive branches
# ===========================================================================


def test_parse_probe_skips_non_dict_streams() -> None:
    raw = _probe_json()
    raw["streams"].insert(0, "not-a-dict")  # type: ignore[arg-type]
    probe = video_probe.parse_probe(raw)
    assert probe.has_video is True
    assert probe.vcodec == "h264"


def test_parse_probe_audio_only_duration_fallback() -> None:
    raw = {
        "format": {"format_name": "mov,mp4"},
        "streams": [{"codec_type": "audio", "codec_name": "aac", "duration": "9.0"}],
    }
    probe = video_probe.parse_probe(raw)
    assert probe.has_video is False
    assert probe.duration_s == 9.0


def test_parse_probe_bad_int_dims_coerce_to_none() -> None:
    raw = _probe_json(width="wide", height="tall")  # type: ignore[arg-type]
    probe = video_probe.parse_probe(raw)
    assert probe.width is None
    assert probe.height is None
    assert probe.aspect_ratio is None


def test_qa_verdict_missing_dims_fails_resolution() -> None:
    raw = _probe_json(width=None, height=None)
    probe = video_probe.parse_probe(raw)
    report = video_probe.video_qa_verdict(probe, ratio="9x16")
    assert any(
        c.check_id == "video.resolution" and c.status == "fail" for c in report.checks
    )


def test_qa_verdict_unknown_duration_fails() -> None:
    probe = video_probe.parse_probe(_probe_json(duration=None))
    # video stream also carries no duration in this fixture.
    report = video_probe.video_qa_verdict(probe, ratio="9x16")
    assert any(
        c.check_id == "video.duration" and c.status == "fail" for c in report.checks
    )


def test_spec_verdict_unprobeable_asset_fails_every_check() -> None:
    probe = video_probe.parse_probe({})
    report = video_probe.video_spec_verdict(probe, _reels_spec())
    assert report.status == "fail"
    failed = {c.check_id for c in report.checks if c.status == "fail"}
    assert {"spec.container", "spec.vcodec", "spec.dimensions", "spec.duration"} <= failed


def test_check_and_report_to_dict_shapes() -> None:
    probe = video_probe.parse_probe(_probe_json())
    report = video_probe.video_spec_verdict(probe, _reels_spec())
    d = report.to_dict()
    assert d["status"] == "pass"
    assert d["ruleset_version"] == video_probe.SPEC_RULESET_VERSION
    assert isinstance(d["checks"], list) and d["checks"][0]["engine"] == "deterministic"
    assert d["defects"] == []  # an all-pass report has no defects
    # A single VideoCheck to_dict carries the video defect_class.
    one = report.checks[0].to_dict()
    assert one["defect_class"] == "video"
