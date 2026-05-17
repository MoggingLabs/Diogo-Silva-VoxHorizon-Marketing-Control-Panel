"""ElevenLabs TTS client + per-segment voiceover orchestration.

V2-3 ships this as a thin async wrapper over the ElevenLabs HTTP API. The
upstream marketing-dept repo has a ``creative-tools/elevenlabs_tts.py``
that we deliberately do NOT shell out to — the worker keeps voiceover
generation in-process so we can stream progress, handle retries, and tie
per-segment audio files directly into the ``video_creatives`` row.

The default model is ``eleven_multilingual_v2`` (highest quality, English-
plus). The MP3 format is ``mp3_44100_128`` because Hyperframes consumes
44.1 kHz audio cleanly and 128 kbps is a fine balance between size and
quality for ad-length voiceover.

Pricing reference (May 2026): ~$0.30 per 1k characters at Creator tier.
The worker doesn't budget — the route layer can compute total character
count before/after to surface cost to the operator.

This module intentionally does NOT touch Supabase, ffmpeg, or storage.
Those concerns live in :mod:`worker.src.routes.video` so this stays a
unit-testable transport.
"""

from __future__ import annotations

import asyncio
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx
import structlog

from ..config import get_settings


log = structlog.get_logger(__name__)


# Default ElevenLabs voice models. v1 always uses multilingual_v2 — the
# only knob is the voice id (per-brief setting). If we want a model switch
# later, hang it off the ``voice_id`` lookup table on the Next.js side.
DEFAULT_MODEL = "eleven_multilingual_v2"

# Output format Hyperframes can mux without re-encoding.
DEFAULT_OUTPUT_FORMAT = "mp3_44100_128"

# Where per-segment MP3 files are buffered before being concatenated.
# Kept under the standard worker temp dir so cleanup is trivial.
DEFAULT_VOICE_TMP_ROOT = Path("~/voxhorizon-worker/tmp/voiceover").expanduser()


@dataclass(frozen=True)
class VoiceoverSegment:
    """One segment's slot in the timeline → MP3 result mapping."""

    idx: int
    voiceover_text: str
    local_path: Path
    bytes_size: int


class ElevenLabsClient:
    """Tiny async wrapper around the ElevenLabs ``/text-to-speech`` endpoint.

    The whole class is intentionally small — under 100 LOC — because every
    line is on the hot path for voiceover gen and the route layer composes
    multiple calls per request. Anything fancy (rate limiting, retries
    beyond a single exponential pass, prompt logging) should land here as
    a focused PR rather than bloat the v1 surface.
    """

    BASE_URL = "https://api.elevenlabs.io/v1"

    def __init__(
        self,
        *,
        api_key: str | None = None,
        timeout_s: float = 60.0,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        settings = get_settings()
        self.api_key = api_key or settings.elevenlabs_api_key
        if not self.api_key:
            raise RuntimeError(
                "ELEVENLABS_API_KEY is not configured — the worker can't "
                "generate voiceover without it."
            )
        self.timeout_s = timeout_s
        # If a client is injected (tests) we don't close it on our way out.
        self._owned_client = client is None
        self._client = client or httpx.AsyncClient(timeout=timeout_s)

    async def close(self) -> None:
        if self._owned_client:
            await self._client.aclose()

    async def __aenter__(self) -> "ElevenLabsClient":
        return self

    async def __aexit__(self, *_: object) -> None:
        await self.close()

    async def synthesize(
        self,
        text: str,
        voice_id: str,
        *,
        model: str = DEFAULT_MODEL,
        output_format: str = DEFAULT_OUTPUT_FORMAT,
        stability: float = 0.5,
        similarity_boost: float = 0.75,
        style: float = 0.0,
        speaker_boost: bool = True,
        speed: float = 1.0,
    ) -> bytes:
        """POST ``/text-to-speech/{voice_id}`` and return the raw MP3 bytes.

        ``speed`` is NOT an ElevenLabs API parameter today (May 2026) — it
        is plumbed into the voice settings payload so that when the API
        starts honoring it (the SDK already has the field) we don't have
        to touch this signature. For now the operator should set the
        script segment duration to match the natural pace of the chosen
        voice.
        """
        url = f"{self.BASE_URL}/text-to-speech/{voice_id}"
        headers = {
            "xi-api-key": self.api_key,
            "accept": "audio/mpeg",
            "content-type": "application/json",
        }
        body: dict[str, Any] = {
            "text": text,
            "model_id": model,
            "output_format": output_format,
            "voice_settings": {
                "stability": stability,
                "similarity_boost": similarity_boost,
                "style": style,
                "use_speaker_boost": speaker_boost,
                "speed": speed,
            },
        }
        resp = await self._client.post(url, headers=headers, json=body)
        if resp.status_code >= 400:
            raise RuntimeError(
                f"ElevenLabs synthesize failed ({resp.status_code}): "
                f"{resp.text[:500]}"
            )
        return resp.content


async def synthesize_segments(
    *,
    client: ElevenLabsClient,
    segments: list[dict[str, Any]],
    voice_id: str,
    tmp_root: Path | None = None,
    speed: float = 1.0,
) -> list[VoiceoverSegment]:
    """Synthesize each segment to its own MP3 file under ``tmp_root``.

    Returns the list of :class:`VoiceoverSegment` in script order so the
    caller can feed them straight into ffmpeg concat. The directory is
    created if missing — callers don't need to pre-stage it.
    """
    root = (tmp_root or DEFAULT_VOICE_TMP_ROOT).expanduser().resolve()
    root.mkdir(parents=True, exist_ok=True)

    out: list[VoiceoverSegment] = []
    for seg in segments:
        idx = int(seg["idx"])
        text = str(seg["voiceover_text"]).strip()
        if not text:
            raise ValueError(f"segment idx={idx} has empty voiceover_text")

        audio_bytes = await client.synthesize(text, voice_id, speed=speed)
        seg_path = root / f"segment-{idx:03d}.mp3"
        seg_path.write_bytes(audio_bytes)

        out.append(
            VoiceoverSegment(
                idx=idx,
                voiceover_text=text,
                local_path=seg_path,
                bytes_size=len(audio_bytes),
            )
        )
        log.info(
            "elevenlabs_segment_ok",
            idx=idx,
            voice_id=voice_id,
            bytes=len(audio_bytes),
            chars=len(text),
        )
    return out


# ---------------------------------------------------------------------------
# ffmpeg concat
# ---------------------------------------------------------------------------


async def ffmpeg_concat_mp3(
    segment_paths: list[Path],
    output_path: Path,
    *,
    ffmpeg_binary: str | None = None,
) -> Path:
    """Concatenate per-segment MP3s into a single file via ffmpeg.

    Uses the demuxer concat protocol (``-f concat -safe 0``) which copies
    streams byte-for-byte — no re-encoding. This requires every input to
    share the same codec / sample rate / bit-rate. We control the inputs
    upstream (``DEFAULT_OUTPUT_FORMAT``) so the constraint always holds.

    The concat list file lands beside ``output_path`` so a debug repro is
    one ``cat`` away.
    """
    if not segment_paths:
        raise ValueError("ffmpeg_concat_mp3 needs at least one segment")

    binary = ffmpeg_binary or shutil.which("ffmpeg") or "ffmpeg"
    output_path = output_path.expanduser().resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)

    # Build the concat file. Paths are quoted to handle spaces; we don't
    # try to escape ``'`` — segment filenames are generated by us above.
    concat_file = output_path.with_suffix(output_path.suffix + ".concat.txt")
    lines = [f"file '{p.expanduser().resolve()}'\n" for p in segment_paths]
    concat_file.write_text("".join(lines))

    cmd = [
        binary,
        "-y",  # overwrite output
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        str(concat_file),
        "-c",
        "copy",
        str(output_path),
    ]
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    _, err_b = await proc.communicate()
    if proc.returncode != 0:
        err = err_b.decode("utf-8", errors="replace")
        raise RuntimeError(f"ffmpeg concat failed (exit {proc.returncode}): {err}")
    return output_path


__all__ = [
    "ElevenLabsClient",
    "VoiceoverSegment",
    "synthesize_segments",
    "ffmpeg_concat_mp3",
    "DEFAULT_MODEL",
    "DEFAULT_OUTPUT_FORMAT",
    "DEFAULT_VOICE_TMP_ROOT",
]
