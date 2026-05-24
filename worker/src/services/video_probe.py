"""Video facts probe + QA / spec evaluators (M3 E3.2 #489 / E3.3 #492).

The video twin of :mod:`worker.src.services.qa_engine`. Where the QA engine
decodes image bytes with Pillow and adjudicates a vision rubric, this module
extracts the *facts* of a finished MP4 with ffprobe (the worker image already
ships ffmpeg/ffprobe -- ``worker/Dockerfile``) and runs pure, deterministic
verdicts over those facts:

  * a **video QA verdict** -- the asset is a shippable ad: it has a real video
    stream, real audio, a positive duration, and a resolution that matches its
    declared aspect ratio. This is the worker-owned backstop the ``qa_run`` route
    rolls onto the ``creative_qa`` gate for video creatives.
  * a **video spec verdict** -- the asset matches a per-placement spec
    (container ``mp4`` / codec ``h264`` / target dimensions / duration band).
    This is the worker recompute the ``spec_result`` route runs *on top of* the
    operator-submitted status, so the operator can never pass a non-conformant
    asset (E3.3 backstop).

Design mirrors the existing Layer-3 engines:

  * **Pure parser + pure evaluators, no I/O.** :func:`parse_probe` turns a raw
    ffprobe JSON dict into a :class:`VideoProbe`; the evaluators are functions of
    a ``VideoProbe`` (+ a spec). They are unit-testable without a subprocess.
  * **Rules as versioned data.** The placement spec rules live in
    :data:`PLACEMENT_SPECS` (mirroring ``compliance_rules.py``'s rules-as-data),
    pinned by :data:`SPEC_RULESET_VERSION`; the QA thresholds pin
    :data:`VIDEO_QA_VERSION` so a persisted verdict records the ruleset it was
    scored against.
  * **Worker owns the verdict.** Nothing here trusts a caller's claim; the
    verdict is computed from the probed facts. An unmeasurable fact never
    auto-passes (it fails or escalates), the same invariant the image engine
    holds.

Only :func:`probe_video` shells out (``asyncio.create_subprocess_exec`` of
ffprobe, mirroring ``ffmpeg_compose.compose`` / ``captions.burn_captions``).
A missing ffprobe raises :class:`RuntimeError` (the route maps it to 503).
"""

from __future__ import annotations

import asyncio
import json
import shutil
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

from . import gate_core


Status = Literal["pass", "fail", "needs_review"]
Severity = Literal["critical", "major", "minor"]


class ProbeError(RuntimeError):
    """Raised when ffprobe exits non-zero or emits unparseable output."""


# ===========================================================================
# Aspect-ratio rails (mirror qa_engine._RATIO_MIN_DIMS keys / aliases)
# ===========================================================================

# The ratio -> (width, height) the placement targets. A video is matched on its
# *ratio* (w/h within a tolerance) rather than an exact pixel size, so a 1080p
# and a 720p 9:16 both read as 9:16; the spec verdict layers the exact-dimension
# check on top when a placement demands it.
_RATIO_WH: dict[str, tuple[int, int]] = {
    "1:1": (1080, 1080),
    "4:5": (1080, 1350),
    "9:16": (1080, 1920),
    "16:9": (1920, 1080),
    "1.91:1": (1080, 566),
}

# Accept the architecture's ``x`` enum spellings as aliases of the ``:`` labels
# (the DB ``ratio`` enum is ``9x16`` etc.; callers may pass either spelling).
_RATIO_ALIASES: dict[str, str] = {
    "1x1": "1:1",
    "4x5": "4:5",
    "9x16": "9:16",
    "16x9": "16:9",
    "1.91x1": "1.91:1",
}

# How far the probed aspect ratio may drift from the target before it is a fail.
# 0.05 absorbs a one-pixel rounding / a 1088-wide encode but rejects a 1:1 sent
# to a 9:16 rail.
_RATIO_TOLERANCE = 0.05

# Codecs / containers we ship. Meta wants H.264 in an MP4 container; ffprobe
# reports the video codec as ``h264`` and the container ``format_name`` as a
# comma list that includes ``mp4`` (``mov,mp4,m4a,3gp,3g2,mj2``).
_ALLOWED_VCODECS: frozenset[str] = frozenset({"h264"})
_ALLOWED_CONTAINERS: frozenset[str] = frozenset({"mp4", "m4v", "mov"})


def _normalise_ratio(ratio: str | None) -> str:
    """Map a caller-supplied ratio label/enum to a canonical ``:`` key."""
    key = (ratio or "").strip().lower()
    return _RATIO_ALIASES.get(key, key)


def _target_ratio_value(ratio: str | None) -> float | None:
    """The numeric w/h for a ratio key, or ``None`` for an unknown rail."""
    wh = _RATIO_WH.get(_normalise_ratio(ratio))
    if wh is None:
        return None
    w, h = wh
    return w / h if h else None


# ===========================================================================
# Probe facts
# ===========================================================================


@dataclass(frozen=True)
class VideoProbe:
    """The ffprobe facts the verdicts need, normalised + typed.

    A pure value object: :func:`parse_probe` builds it from raw ffprobe JSON and
    the evaluators read it. ``container`` is the first token of ffprobe's
    ``format_name`` comma list (the demuxer family); ``vcodec`` / ``acodec`` are
    the stream codec names (``None`` when that stream is absent).
    """

    container: str | None
    vcodec: str | None
    acodec: str | None
    width: int | None
    height: int | None
    duration_s: float | None
    has_video: bool
    has_audio: bool
    fps: float | None = None

    @property
    def aspect_ratio(self) -> float | None:
        """Probed width / height, or ``None`` when either is missing/zero."""
        if self.width and self.height:
            return self.width / self.height
        return None

    def to_dict(self) -> dict[str, Any]:
        """JSON-serialisable facts (persisted on the qa_result / spec evidence)."""
        return {
            "container": self.container,
            "vcodec": self.vcodec,
            "acodec": self.acodec,
            "width": self.width,
            "height": self.height,
            "duration_s": self.duration_s,
            "has_video": self.has_video,
            "has_audio": self.has_audio,
            "fps": self.fps,
        }


def _coerce_float(value: Any) -> float | None:
    try:
        out = float(value)
    except (TypeError, ValueError):
        return None
    return out


def _coerce_int(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _parse_fps(rate: Any) -> float | None:
    """Parse an ffprobe rate string (``"30/1"`` / ``"30000/1001"``) to fps."""
    if rate is None:
        return None
    text = str(rate).strip()
    if not text or text in ("0/0", "0"):
        return None
    if "/" in text:
        num, _, den = text.partition("/")
        n = _coerce_float(num)
        d = _coerce_float(den)
        if n is None or not d:
            return None
        return n / d
    return _coerce_float(text)


def parse_probe(probe_json: dict[str, Any]) -> VideoProbe:
    """Parse a raw ffprobe ``-print_format json`` dict into a :class:`VideoProbe`.

    PURE -- no subprocess. Reads the ``format`` block (container + duration) and
    the ``streams`` list (first video stream for codec/dims/fps, first audio
    stream for the audio codec). Duration falls back from the format block to the
    video stream when the container omits it (some MP4s do). Missing fields
    resolve to ``None``/``False`` so an evaluator can fail rather than crash on a
    partial probe.
    """
    fmt = probe_json.get("format") or {}
    streams = probe_json.get("streams") or []

    container = None
    format_name = fmt.get("format_name")
    if isinstance(format_name, str) and format_name.strip():
        container = format_name.split(",")[0].strip().lower()

    duration_s = _coerce_float(fmt.get("duration"))

    video_stream: dict[str, Any] | None = None
    audio_stream: dict[str, Any] | None = None
    for stream in streams:
        if not isinstance(stream, dict):
            continue
        codec_type = str(stream.get("codec_type") or "").lower()
        if codec_type == "video" and video_stream is None:
            video_stream = stream
        elif codec_type == "audio" and audio_stream is None:
            audio_stream = stream

    vcodec = None
    width = height = None
    fps = None
    if video_stream is not None:
        name = video_stream.get("codec_name")
        vcodec = str(name).strip().lower() if isinstance(name, str) else None
        width = _coerce_int(video_stream.get("width"))
        height = _coerce_int(video_stream.get("height"))
        fps = _parse_fps(
            video_stream.get("avg_frame_rate") or video_stream.get("r_frame_rate")
        )
        if duration_s is None:
            duration_s = _coerce_float(video_stream.get("duration"))

    acodec = None
    if audio_stream is not None:
        name = audio_stream.get("codec_name")
        acodec = str(name).strip().lower() if isinstance(name, str) else None
        if duration_s is None:
            duration_s = _coerce_float(audio_stream.get("duration"))

    return VideoProbe(
        container=container,
        vcodec=vcodec,
        acodec=acodec,
        width=width,
        height=height,
        duration_s=duration_s,
        has_video=video_stream is not None,
        has_audio=audio_stream is not None,
        fps=fps,
    )


# ===========================================================================
# Check result / report shapes (mirror qa_engine.CheckResult / QAReport)
# ===========================================================================


@dataclass(frozen=True)
class VideoCheck:
    """The outcome of one video check against one probe."""

    check_id: str
    severity: Severity
    status: Status
    detail: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "check_id": self.check_id,
            "engine": "deterministic",
            "defect_class": "video",
            "severity": self.severity,
            "status": self.status,
            "detail": self.detail,
            "score": None,
            "threshold": None,
        }


@dataclass(frozen=True)
class VideoReport:
    """A rolled-up video verdict (QA or spec) plus the checks behind it."""

    status: Status
    checks: list[VideoCheck] = field(default_factory=list)
    ruleset_version: str = ""

    @property
    def passed(self) -> bool:
        return self.status == "pass"

    def to_dict(self) -> dict[str, Any]:
        return {
            "status": self.status,
            "ruleset_version": self.ruleset_version,
            "checks": [c.to_dict() for c in self.checks],
            "defects": [
                {
                    "check_id": c.check_id,
                    "defect_class": "video",
                    "severity": c.severity,
                    "detail": c.detail,
                }
                for c in self.checks
                if c.status in ("fail", "needs_review")
            ],
        }


def _rollup(checks: list[VideoCheck]) -> Status:
    """Any ``fail`` -> ``fail``; else any ``needs_review`` -> ``needs_review``.

    The shared rollup with no severity gate (every fail blocks), mirroring the
    image QA engine.
    """
    return gate_core.rollup(checks, verdict_of=lambda c: c.status)


# ===========================================================================
# Video QA verdict (E3.2)
# ===========================================================================

# QA threshold version -- bump on any QA rule change so a persisted qa_result
# pins the ruleset it was scored against (append-only evidence, per Layer 2).
VIDEO_QA_VERSION = "2026.05.1"


def video_qa_verdict(probe: VideoProbe, *, ratio: str | None = None) -> VideoReport:
    """Adjudicate one composed/captioned video as a shippable ad. PURE.

    Worker-owned backstops (no caller claim is trusted):

      * ``video.has_video``    -- a real video stream is present.
      * ``video.has_audio``    -- a real audio stream is present (a short-form ad
        with no voiceover/music track is almost always a broken render).
      * ``video.duration``     -- a positive duration (a 0s asset is broken).
      * ``video.resolution``   -- the probed aspect ratio matches the declared
        ``ratio`` within tolerance. An unknown ratio escalates to
        ``needs_review`` (never auto-passes an unmeasurable rail, mirroring the
        image engine).

    Any failing check -> ``fail`` (routes to a re-render); an unmeasurable but
    not-broken fact -> ``needs_review``.
    """
    checks: list[VideoCheck] = []

    if probe.has_video:
        checks.append(
            VideoCheck("video.has_video", "critical", "pass", "Video stream present.")
        )
    else:
        checks.append(
            VideoCheck(
                "video.has_video", "critical", "fail", "No video stream in the asset."
            )
        )

    if probe.has_audio:
        checks.append(
            VideoCheck("video.has_audio", "critical", "pass", "Audio stream present.")
        )
    else:
        checks.append(
            VideoCheck(
                "video.has_audio",
                "critical",
                "fail",
                "No audio stream (a short-form ad needs a voiceover/music track).",
            )
        )

    if probe.duration_s is None:
        checks.append(
            VideoCheck(
                "video.duration",
                "critical",
                "fail",
                "Duration is unknown (unprobeable / broken asset).",
            )
        )
    elif probe.duration_s > 0:
        checks.append(
            VideoCheck(
                "video.duration",
                "critical",
                "pass",
                f"Duration {probe.duration_s:.2f}s > 0.",
            )
        )
    else:
        checks.append(
            VideoCheck(
                "video.duration",
                "critical",
                "fail",
                f"Duration {probe.duration_s:.2f}s is not positive.",
            )
        )

    target = _target_ratio_value(ratio)
    actual = probe.aspect_ratio
    if actual is None:
        checks.append(
            VideoCheck(
                "video.resolution",
                "major",
                "fail",
                "Cannot measure resolution (missing width/height).",
            )
        )
    elif target is None:
        checks.append(
            VideoCheck(
                "video.resolution",
                "major",
                "needs_review",
                f"Unknown ratio {ratio!r}; cannot apply a resolution rail.",
            )
        )
    elif abs(actual - target) <= _RATIO_TOLERANCE:
        checks.append(
            VideoCheck(
                "video.resolution",
                "major",
                "pass",
                f"{probe.width}x{probe.height} matches "
                f"{_normalise_ratio(ratio)} (~{target:.3f}).",
            )
        )
    else:
        checks.append(
            VideoCheck(
                "video.resolution",
                "major",
                "fail",
                f"{probe.width}x{probe.height} (ar {actual:.3f}) does not match "
                f"{_normalise_ratio(ratio)} (~{target:.3f}).",
            )
        )

    return VideoReport(
        status=_rollup(checks), checks=checks, ruleset_version=VIDEO_QA_VERSION
    )


# ===========================================================================
# Placement specs (rules-as-versioned-data; mirror compliance_rules.py)
# ===========================================================================

# Bump on any spec rule change so a persisted spec verdict pins the ruleset.
SPEC_RULESET_VERSION = "2026.05.1"


@dataclass(frozen=True)
class PlacementSpec:
    """One placement's video container/codec/dimension/duration requirement.

    Rules-as-data: a placement maps to a required container + video codec, a
    target ``ratio`` (the aspect rail), optional exact ``width``/``height`` (when
    the placement demands a precise encode, not just the right ratio), and a
    duration band ``[min_duration_s, max_duration_s]`` (``None`` = unbounded).
    """

    placement: str
    version: str
    container: str = "mp4"
    vcodec: str = "h264"
    ratio: str = "9:16"
    width: int | None = None
    height: int | None = None
    min_duration_s: float | None = None
    max_duration_s: float | None = None
    require_audio: bool = True


# The starter placement specs. Vertical short-form lives in the 9:16 reel/story
# rail; the feed-video placement is 1:1; a 16:9 in-stream rail rounds it out.
# Durations follow Meta's short-form guidance (reels up to ~90s; feed video up
# to ~241s but practically capped; we cap the ad rails conservatively).
_PLACEMENT_SPECS: tuple[PlacementSpec, ...] = (
    PlacementSpec(
        placement="reels",
        version=SPEC_RULESET_VERSION,
        ratio="9:16",
        min_duration_s=3.0,
        max_duration_s=90.0,
    ),
    PlacementSpec(
        placement="stories",
        version=SPEC_RULESET_VERSION,
        ratio="9:16",
        min_duration_s=1.0,
        max_duration_s=60.0,
    ),
    PlacementSpec(
        placement="feed",
        version=SPEC_RULESET_VERSION,
        ratio="1:1",
        min_duration_s=3.0,
        max_duration_s=241.0,
    ),
    PlacementSpec(
        placement="in_stream",
        version=SPEC_RULESET_VERSION,
        ratio="16:9",
        min_duration_s=5.0,
        max_duration_s=241.0,
    ),
)

# Aliases so a placement label from the operator/spec routes resolves onto a
# canonical spec (the DB placement_enum + the operator's verbs).
_PLACEMENT_ALIASES: dict[str, str] = {
    "reel": "reels",
    "story": "stories",
    "feed_video": "feed",
    "feed": "feed",
    "instream": "in_stream",
    "in-stream": "in_stream",
}


def get_placement_specs() -> tuple[PlacementSpec, ...]:
    """Return the starter placement specs (immutable frozen dataclasses)."""
    return _PLACEMENT_SPECS


def get_placement_spec(placement: str | None) -> PlacementSpec | None:
    """Resolve a placement label to its :class:`PlacementSpec`, or ``None``."""
    key = (placement or "").strip().lower()
    key = _PLACEMENT_ALIASES.get(key, key)
    for spec in _PLACEMENT_SPECS:
        if spec.placement == key:
            return spec
    return None


# ===========================================================================
# Video spec verdict (E3.3 backstop)
# ===========================================================================


def video_spec_verdict(probe: VideoProbe, spec: PlacementSpec) -> VideoReport:
    """Recompute one placement's spec verdict from the probed facts. PURE.

    Checks the actual asset against the placement ``spec``: container, video
    codec, aspect ratio (and exact dimensions when the spec pins them), the
    duration band, and audio presence when required. Every check is computed
    from ``probe`` -- a caller can never assert a pass. A ``fail`` on any check
    rolls the verdict to ``fail`` (the route downgrades the operator status).
    """
    checks: list[VideoCheck] = []

    # -- container --
    if probe.container is None:
        checks.append(
            VideoCheck(
                "spec.container",
                "critical",
                "fail",
                "Container is unknown (unprobeable asset).",
            )
        )
    elif (
        probe.container == spec.container or probe.container in _ALLOWED_CONTAINERS
    ) and spec.container in _ALLOWED_CONTAINERS:
        checks.append(
            VideoCheck(
                "spec.container",
                "critical",
                "pass",
                f"Container {probe.container} satisfies {spec.container}.",
            )
        )
    else:
        checks.append(
            VideoCheck(
                "spec.container",
                "critical",
                "fail",
                f"Container {probe.container} does not match required "
                f"{spec.container}.",
            )
        )

    # -- video codec --
    if probe.vcodec is None:
        checks.append(
            VideoCheck(
                "spec.vcodec", "critical", "fail", "No video codec (no video stream)."
            )
        )
    elif probe.vcodec == spec.vcodec or probe.vcodec in _ALLOWED_VCODECS:
        checks.append(
            VideoCheck(
                "spec.vcodec",
                "critical",
                "pass",
                f"Video codec {probe.vcodec} satisfies {spec.vcodec}.",
            )
        )
    else:
        checks.append(
            VideoCheck(
                "spec.vcodec",
                "critical",
                "fail",
                f"Video codec {probe.vcodec} does not match required "
                f"{spec.vcodec}.",
            )
        )

    # -- aspect ratio (and exact dims when pinned) --
    target = _target_ratio_value(spec.ratio)
    actual = probe.aspect_ratio
    if actual is None or target is None:
        checks.append(
            VideoCheck(
                "spec.dimensions",
                "critical",
                "fail",
                f"Cannot verify dimensions ({probe.width}x{probe.height}) "
                f"against {spec.ratio}.",
            )
        )
    elif abs(actual - target) > _RATIO_TOLERANCE:
        checks.append(
            VideoCheck(
                "spec.dimensions",
                "critical",
                "fail",
                f"{probe.width}x{probe.height} (ar {actual:.3f}) does not match "
                f"{spec.ratio} (~{target:.3f}).",
            )
        )
    elif spec.width is not None and spec.height is not None and (
        probe.width != spec.width or probe.height != spec.height
    ):
        checks.append(
            VideoCheck(
                "spec.dimensions",
                "major",
                "fail",
                f"{probe.width}x{probe.height} does not match the exact "
                f"{spec.width}x{spec.height} the placement requires.",
            )
        )
    else:
        checks.append(
            VideoCheck(
                "spec.dimensions",
                "critical",
                "pass",
                f"{probe.width}x{probe.height} matches {spec.ratio}.",
            )
        )

    # -- duration band --
    if probe.duration_s is None:
        checks.append(
            VideoCheck(
                "spec.duration", "major", "fail", "Duration is unknown."
            )
        )
    elif spec.min_duration_s is not None and probe.duration_s < spec.min_duration_s:
        checks.append(
            VideoCheck(
                "spec.duration",
                "major",
                "fail",
                f"Duration {probe.duration_s:.2f}s is below the "
                f"{spec.min_duration_s:.2f}s minimum.",
            )
        )
    elif spec.max_duration_s is not None and probe.duration_s > spec.max_duration_s:
        checks.append(
            VideoCheck(
                "spec.duration",
                "major",
                "fail",
                f"Duration {probe.duration_s:.2f}s exceeds the "
                f"{spec.max_duration_s:.2f}s ceiling.",
            )
        )
    else:
        checks.append(
            VideoCheck(
                "spec.duration",
                "major",
                "pass",
                f"Duration {probe.duration_s:.2f}s within band.",
            )
        )

    # -- audio presence (when required) --
    if spec.require_audio and not probe.has_audio:
        checks.append(
            VideoCheck(
                "spec.audio",
                "major",
                "fail",
                "No audio stream, but the placement requires one.",
            )
        )

    return VideoReport(
        status=_rollup(checks), checks=checks, ruleset_version=spec.version
    )


# ===========================================================================
# ffprobe runner (the only impure entry point)
# ===========================================================================


def build_probe_argv(path: str | Path, *, ffprobe_bin: str = "ffprobe") -> list[str]:
    """Build the ffprobe argv that emits the format + streams JSON. PURE."""
    return [
        ffprobe_bin or "ffprobe",
        "-v",
        "error",
        "-print_format",
        "json",
        "-show_format",
        "-show_streams",
        str(path),
    ]


async def probe_video(
    path: str | Path, *, ffprobe_bin: str | None = None
) -> VideoProbe:
    """Run ffprobe on ``path`` and return the parsed :class:`VideoProbe`.

    Locates ffprobe (``ffprobe_bin`` or PATH), shells it out off the event loop
    (``asyncio.create_subprocess_exec``, mirroring ``ffmpeg_compose.compose``),
    and parses its JSON with the pure :func:`parse_probe`.

    Raises:
        RuntimeError: ffprobe not found on PATH (it ships in the worker image;
            the route maps this to 503).
        ProbeError: the input is missing, ffprobe exited non-zero, or emitted
            output that did not parse as JSON.
    """
    resolved_bin = ffprobe_bin or shutil.which("ffprobe")
    if not resolved_bin:
        raise RuntimeError(
            "ffprobe not found on PATH -- it ships in the worker image; install "
            "ffmpeg to probe videos locally."
        )
    if not Path(path).exists():
        raise ProbeError(f"probe input does not exist: {path}")

    argv = build_probe_argv(path, ffprobe_bin=resolved_bin)
    proc = await asyncio.create_subprocess_exec(
        *argv,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    out_b, err_b = await proc.communicate()
    if proc.returncode != 0:
        stderr = err_b.decode("utf-8", errors="replace")
        raise ProbeError(
            f"ffprobe exited {proc.returncode}: {stderr.strip()[-500:] or 'no stderr'}"
        )

    try:
        probe_json = json.loads(out_b.decode("utf-8", errors="replace") or "{}")
    except (ValueError, TypeError) as e:
        raise ProbeError(f"ffprobe emitted unparseable JSON: {e}") from e
    if not isinstance(probe_json, dict):
        raise ProbeError("ffprobe JSON was not an object")
    return parse_probe(probe_json)


__all__ = [
    "ProbeError",
    "VideoProbe",
    "VideoCheck",
    "VideoReport",
    "PlacementSpec",
    "VIDEO_QA_VERSION",
    "SPEC_RULESET_VERSION",
    "parse_probe",
    "probe_video",
    "build_probe_argv",
    "video_qa_verdict",
    "video_spec_verdict",
    "get_placement_specs",
    "get_placement_spec",
]
