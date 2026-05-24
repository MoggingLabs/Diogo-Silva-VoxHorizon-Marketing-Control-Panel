"""Self-hosted caption burn-in for video ads.

Turns a voiceover audio track into styled, hard-burned captions on the composed
clip -- the punchy word-group captions short-form ads live and die by. All
local: faster-whisper (CTranslate2, no torch) for word-level timestamps, an ASS
subtitle file we render ourselves, and the ffmpeg already in the worker image to
burn it in. No hosted captioning vendor and no spend.

Split so the parts that matter are testable without a model or ffmpeg:

  * :func:`group_words_into_cues` -- PURE. Greedily packs word timings into short
    on-screen cues (respecting a max char width, max duration, and a gap split).
  * :func:`build_ass` -- PURE. Renders cues into an ASS subtitle document with a
    bold, outlined, bottom-centered style sized for a 1080x1920 frame.
  * :func:`build_burn_argv` -- PURE. Builds the ffmpeg argv that burns an ASS
    file into a video via the ``ass`` filter (video re-encoded, audio copied).
  * :func:`transcribe` -- async. Lazily imports ``faster_whisper`` and returns a
    flat list of word timings (model run off-thread). The import is lazy so this
    module loads (and its pure helpers test) without the dep resolved.
  * :func:`burn_captions` / :func:`caption_video` -- async runners (mirror
    services.ffmpeg_compose / services.image_compositor).

The Whisper model weights are NOT baked into the image; faster-whisper downloads
the chosen size to the HuggingFace cache on first :func:`transcribe` (the worker
has outbound egress). Pre-baking the model in the Dockerfile is a deploy-time
optimization for when the video pipeline is enabled. This module is dormant until
the video.py substage chain wires it (VID-5).
"""

from __future__ import annotations

import asyncio
import shutil
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path

import structlog


log = structlog.get_logger(__name__)


# Caption packing defaults, tuned for vertical short-form: a couple of words on
# screen at a time, never lingering, split when the speaker pauses.
DEFAULT_MAX_CHARS = 42
DEFAULT_MAX_CUE_DUR = 3.0  # seconds
DEFAULT_MAX_GAP = 0.6  # seconds of silence that forces a new cue

# faster-whisper defaults for a CPU-only container. "base" is the accuracy/speed
# sweet spot for clean voiceover; int8 keeps it light.
DEFAULT_MODEL_SIZE = "base"
DEFAULT_DEVICE = "cpu"
DEFAULT_COMPUTE_TYPE = "int8"

# ASS style defaults for a 1080x1920 frame: big bold white with a heavy black
# outline, sitting above the lower third so it clears most UI chrome.
DEFAULT_WIDTH = 1080
DEFAULT_HEIGHT = 1920
DEFAULT_FONT = "Arial"
DEFAULT_FONT_SIZE = 84
DEFAULT_PRIMARY_COLOUR = "&H00FFFFFF"  # ABGR: opaque white
DEFAULT_OUTLINE_COLOUR = "&H00000000"  # ABGR: opaque black
DEFAULT_OUTLINE = 4
DEFAULT_MARGIN_V = 260


class CaptionError(RuntimeError):
    """Raised when transcription or the ffmpeg burn-in fails."""


@dataclass(frozen=True)
class Word:
    """One transcribed word with its start/end time in seconds."""

    text: str
    start: float
    end: float


@dataclass(frozen=True)
class Cue:
    """One on-screen caption (a group of words) with its start/end seconds."""

    text: str
    start: float
    end: float


@dataclass(frozen=True)
class CaptionResult:
    """Outcome of one :func:`caption_video` call."""

    output_path: Path
    ass_path: Path
    cue_count: int


# ---------------------------------------------------------------------------
# Pure helpers
# ---------------------------------------------------------------------------


def group_words_into_cues(
    words: Sequence[Word],
    *,
    max_chars: int = DEFAULT_MAX_CHARS,
    max_cue_dur: float = DEFAULT_MAX_CUE_DUR,
    max_gap: float = DEFAULT_MAX_GAP,
) -> list[Cue]:
    """Greedily pack ``words`` into short caption cues.

    A new cue is started when adding the next word would exceed ``max_chars``,
    when the running cue would run past ``max_cue_dur`` seconds, or when there is
    a silence gap larger than ``max_gap`` before the next word. Empty/whitespace
    words are skipped. Pure.
    """
    cues: list[Cue] = []
    buf: list[Word] = []

    def flush() -> None:
        if buf:
            text = " ".join(w.text.strip() for w in buf).strip()
            if text:
                cues.append(Cue(text=text, start=buf[0].start, end=buf[-1].end))
        buf.clear()

    for w in words:
        token = w.text.strip()
        if not token:
            continue
        if buf:
            gap = w.start - buf[-1].end
            joined = " ".join(x.text.strip() for x in buf)
            prospective = len(joined) + 1 + len(token)
            duration = w.end - buf[0].start
            if gap > max_gap or prospective > max_chars or duration > max_cue_dur:
                flush()
        buf.append(w)
    flush()
    return cues


def _fmt_ass_ts(seconds: float) -> str:
    """Format ``seconds`` as an ASS timestamp ``H:MM:SS.cc`` (centiseconds)."""
    if seconds < 0:
        seconds = 0.0
    total_cs = round(seconds * 100)
    cs = total_cs % 100
    total_s = total_cs // 100
    s = total_s % 60
    total_m = total_s // 60
    m = total_m % 60
    h = total_m // 60
    return f"{h}:{m:02d}:{s:02d}.{cs:02d}"


def _ass_escape(text: str) -> str:
    """Escape caption text for an ASS Dialogue line.

    Collapses hard newlines to the ASS line break ``\\N`` and neutralizes braces
    so they cannot be parsed as ASS override tags.
    """
    return (
        text.replace("\r", "")
        .replace("\n", "\\N")
        .replace("{", "(")
        .replace("}", ")")
        .strip()
    )


def build_ass(
    cues: Sequence[Cue],
    *,
    width: int = DEFAULT_WIDTH,
    height: int = DEFAULT_HEIGHT,
    font: str = DEFAULT_FONT,
    font_size: int = DEFAULT_FONT_SIZE,
    primary_colour: str = DEFAULT_PRIMARY_COLOUR,
    outline_colour: str = DEFAULT_OUTLINE_COLOUR,
    outline: int = DEFAULT_OUTLINE,
    margin_v: int = DEFAULT_MARGIN_V,
    bold: bool = True,
) -> str:
    """Render ``cues`` into an ASS subtitle document. Pure.

    The single ``Default`` style is bold white with a heavy outline, bottom-center
    aligned (alignment 2) and lifted by ``margin_v``. ``PlayResX/Y`` are set to
    the target frame so font sizes are absolute pixels.
    """
    bold_flag = -1 if bold else 0
    lines: list[str] = [
        "[Script Info]",
        "ScriptType: v4.00+",
        f"PlayResX: {width}",
        f"PlayResY: {height}",
        "WrapStyle: 2",
        "ScaledBorderAndShadow: yes",
        "",
        "[V4+ Styles]",
        (
            "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, "
            "OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, "
            "ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, "
            "Alignment, MarginL, MarginR, MarginV, Encoding"
        ),
        (
            f"Style: Default,{font},{font_size},{primary_colour},&H000000FF,"
            f"{outline_colour},&H64000000,{bold_flag},0,0,0,100,100,0,0,1,"
            f"{outline},0,2,60,60,{margin_v},1"
        ),
        "",
        "[Events]",
        (
            "Format: Layer, Start, End, Style, Name, MarginL, MarginR, "
            "MarginV, Effect, Text"
        ),
    ]
    for cue in cues:
        start = _fmt_ass_ts(cue.start)
        end = _fmt_ass_ts(cue.end)
        text = _ass_escape(cue.text)
        lines.append(f"Dialogue: 0,{start},{end},Default,,0,0,0,,{text}")
    return "\n".join(lines) + "\n"


def _escape_filter_path(path: str) -> str:
    """Escape a path for use inside an ffmpeg filtergraph option value.

    The worker runs on Linux so paths are POSIX; we still escape ``\\`` and the
    ``:`` separator so the ``ass`` filter does not mis-split the filename.
    """
    return path.replace("\\", "\\\\").replace(":", "\\:")


def build_burn_argv(
    *,
    video: str | Path,
    ass_path: str | Path,
    output: str | Path,
    ffmpeg_bin: str = "ffmpeg",
    overwrite: bool = True,
) -> list[str]:
    """Build the ffmpeg argv that burns ``ass_path`` into ``video``. Pure.

    The video is re-encoded (H.264 / yuv420p / faststart) because the ``ass``
    filter rewrites pixels; the audio is stream-copied (``-c:a copy``) since
    burn-in never touches it.
    """
    argv: list[str] = [ffmpeg_bin or "ffmpeg"]
    if overwrite:
        argv.append("-y")
    argv += ["-i", str(video)]
    argv += ["-vf", "ass=" + _escape_filter_path(str(ass_path))]
    argv += [
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        "-c:a",
        "copy",
        str(output),
    ]
    return argv


# ---------------------------------------------------------------------------
# Transcription (faster-whisper, lazily imported)
# ---------------------------------------------------------------------------

# Loaded WhisperModels are reused across calls (loading is expensive), keyed by
# the (size, device, compute_type) tuple.
_MODEL_CACHE: dict[tuple[str, str, str], object] = {}


def _load_model(model_size: str, device: str, compute_type: str) -> object:
    """Return a cached faster-whisper ``WhisperModel`` (lazy import)."""
    key = (model_size, device, compute_type)
    model = _MODEL_CACHE.get(key)
    if model is None:
        from faster_whisper import WhisperModel  # lazy: heavy, optional at import

        model = WhisperModel(model_size, device=device, compute_type=compute_type)
        _MODEL_CACHE[key] = model
    return model


async def transcribe(
    audio: str | Path,
    *,
    model_size: str = DEFAULT_MODEL_SIZE,
    language: str | None = None,
    device: str = DEFAULT_DEVICE,
    compute_type: str = DEFAULT_COMPUTE_TYPE,
) -> list[Word]:
    """Transcribe ``audio`` to a flat list of word timings.

    Runs the (blocking, CPU-bound) model off the event loop via
    :func:`asyncio.to_thread`. Raises :class:`CaptionError` if the audio file is
    missing.
    """
    path = Path(audio)
    if not path.exists():
        raise CaptionError(f"transcribe input does not exist: {audio}")

    def _run() -> list[Word]:
        model = _load_model(model_size, device, compute_type)
        segments, _info = model.transcribe(  # type: ignore[attr-defined]
            str(path), language=language, word_timestamps=True
        )
        words: list[Word] = []
        for seg in segments:
            for w in getattr(seg, "words", None) or []:
                words.append(Word(text=w.word, start=float(w.start), end=float(w.end)))
        return words

    words = await asyncio.to_thread(_run)
    log.info("captions_transcribed", audio=str(path), words=len(words), model=model_size)
    return words


# ---------------------------------------------------------------------------
# ffmpeg burn-in + orchestration
# ---------------------------------------------------------------------------


async def burn_captions(
    *,
    video: str | Path,
    ass_path: str | Path,
    output: str | Path,
    ffmpeg_bin: str | None = None,
) -> Path:
    """Burn ``ass_path`` into ``video`` with ffmpeg, returning the output path.

    Raises:
        RuntimeError: ffmpeg not found on PATH (it ships in the worker image).
        CaptionError: a missing input, a non-zero exit, or no output written.
    """
    resolved_bin = ffmpeg_bin or shutil.which("ffmpeg")
    if not resolved_bin:
        raise RuntimeError(
            "ffmpeg not found on PATH -- it ships in the worker image; install "
            "ffmpeg to burn captions locally."
        )
    for src in (video, ass_path):
        if not Path(src).exists():
            raise CaptionError(f"caption burn-in input does not exist: {src}")

    argv = build_burn_argv(
        video=video, ass_path=ass_path, output=output, ffmpeg_bin=resolved_bin
    )
    proc = await asyncio.create_subprocess_exec(
        *argv,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    _out_b, err_b = await proc.communicate()
    stderr = err_b.decode("utf-8", errors="replace")

    if proc.returncode != 0:
        log.warning(
            "captions_burn_failed",
            returncode=proc.returncode,
            stderr_tail=stderr[-800:],
        )
        raise CaptionError(
            f"ffmpeg burn-in exited {proc.returncode}: "
            f"{stderr.strip()[-500:] or 'no stderr'}"
        )

    out_path = Path(output)
    if not out_path.exists():
        raise CaptionError(
            f"ffmpeg reported success but {out_path} was not written"
        )
    return out_path


async def caption_video(
    *,
    video: str | Path,
    audio: str | Path,
    output: str | Path,
    ass_path: str | Path | None = None,
    model_size: str = DEFAULT_MODEL_SIZE,
    language: str | None = None,
    device: str = DEFAULT_DEVICE,
    compute_type: str = DEFAULT_COMPUTE_TYPE,
    max_chars: int = DEFAULT_MAX_CHARS,
    max_cue_dur: float = DEFAULT_MAX_CUE_DUR,
    max_gap: float = DEFAULT_MAX_GAP,
    ffmpeg_bin: str | None = None,
    **style: object,
) -> CaptionResult:
    """Transcribe ``audio``, render an ASS, and burn it into ``video``.

    The high-level entry the video pipeline calls (VID-5): transcribe the
    voiceover, pack words into cues, write the ASS next to the output (or to
    ``ass_path``), and burn it in. Extra keyword args are forwarded to
    :func:`build_ass` (e.g. ``font_size``, ``margin_v``). If transcription yields
    no words the ASS simply has no Dialogue lines (the burn is a visual no-op).
    """
    words = await transcribe(
        audio,
        model_size=model_size,
        language=language,
        device=device,
        compute_type=compute_type,
    )
    cues = group_words_into_cues(
        words, max_chars=max_chars, max_cue_dur=max_cue_dur, max_gap=max_gap
    )

    ass = Path(ass_path) if ass_path is not None else Path(output).with_suffix(".ass")
    ass.write_text(build_ass(cues, **style), encoding="utf-8")  # type: ignore[arg-type]

    out = await burn_captions(
        video=video, ass_path=ass, output=output, ffmpeg_bin=ffmpeg_bin
    )
    log.info("captions_burned", output=str(out), cues=len(cues))
    return CaptionResult(output_path=out, ass_path=ass, cue_count=len(cues))
