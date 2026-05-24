"""Kie.ai TEXT-TO-SPEECH (voiceover) client.

Voiceover for the video pipeline. The HI-8 wipe removed the old ElevenLabs SaaS
client; kie.ai resells ElevenLabs TTS through the SAME unified Jobs API the image
(:mod:`services.kie`) and video (:mod:`services.kie_video`) clients already use,
so voiceover needs no new vendor or key:

  * ``POST /api/v1/jobs/createTask`` with ``model="elevenlabs/text-to-speech-
    multilingual-v2"`` and the text/voice/speed under ``input``.
  * ``GET /api/v1/jobs/recordInfo?taskId=...`` -- status is a string ``state``;
    the audio URL lives inside ``data.resultJson`` (a JSON STRING to parse),
    exactly like the unified video path.

This mirrors the unified half of :class:`services.kie_video.KieVideoClient`: same
auth, per-call ``httpx.AsyncClient``, ``transport`` test seam, ``FAKE_RENDER``
short-circuit, and :class:`services.kie.KieError` type.

Contract:

  - ``KieTtsClient.synthesize(text, *, voice, model=DEFAULT_TTS_MODEL, speed=1.0,
    language_code=None, stability=None, similarity_boost=None, style=None,
    callback_url=None)`` submits a job, polls until done, and returns a
    :class:`KieTtsResult` with the audio URL. The bytes are NOT downloaded here
    -- the voiceover stage fetches them (or call :meth:`download_audio`).
  - ``KieTtsClient.download_audio(url)`` fetches a result clip's bytes.
  - Failures raise :class:`services.kie.KieError`.

The caller synthesizes ONE script segment per call (each well under the 5000-char
ElevenLabs limit) and concatenates the segment MP3s with ffmpeg downstream.
Dormant until the video.py voiceover handler wires it (VID-5).
"""

from __future__ import annotations

import asyncio
import hashlib
import json
from dataclasses import dataclass, field
from typing import Any

import httpx
import structlog

from ..config import get_settings
from .kie import CREATE_TASK_URL, RECORD_INFO_URL, KieError


log = structlog.get_logger(__name__)


# kie resells ElevenLabs TTS on the unified Jobs API -- the same endpoints the
# image + video clients post to.
JOBS_CREATE_TASK_URL = CREATE_TASK_URL
JOBS_RECORD_INFO_URL = RECORD_INFO_URL

# Confirmed TTS model on kie's market (docs.kie.ai/market/elevenlabs/
# text-to-speech-multilingual-v2). Voiceover defaults to the multilingual v2.
TTS_MODEL_MULTILINGUAL_V2 = "elevenlabs/text-to-speech-multilingual-v2"
DEFAULT_TTS_MODEL = TTS_MODEL_MULTILINGUAL_V2

# ElevenLabs' per-request hard limit. The caller chunks per script segment, each
# well under this; we reject over-long text rather than risk a silent 400.
MAX_TEXT_CHARS = 5000
# kie's documented speed bounds.
MIN_SPEED = 0.7
MAX_SPEED = 1.2

# TTS returns faster than video; poll tighter. 2s x 90 = 3 min ceiling. Tests
# monkeypatch these to run instantly.
POLL_INTERVAL_S = 2.0
MAX_TTS_POLL_ATTEMPTS = 90


class KieTtsError(KieError):
    """Alias of :class:`services.kie.KieError` for the TTS call sites.

    Subclass (not just an alias) so ``except KieTtsError`` is possible while
    ``except KieError`` still catches the image, video, and TTS paths.
    """


@dataclass(frozen=True)
class KieTtsResult:
    """Bundle returned by :meth:`KieTtsClient.synthesize`.

    ``audio_url`` is the primary result; ``all_urls`` keeps the full list. The
    bytes are NOT downloaded here -- the voiceover stage fetches ``audio_url``
    (or :meth:`KieTtsClient.download_audio`).
    """

    audio_url: str
    task_id: str
    model: str
    all_urls: list[str] = field(default_factory=list)


def fake_tts_result(text: str, voice: str, model: str) -> KieTtsResult:
    """Deterministic fake result for FAKE_RENDER mode (no network, no spend)."""
    digest = hashlib.sha256(
        f"{text}|{voice}|{model}".encode("utf-8")
    ).hexdigest()[:16]
    url = f"https://fake.kie.local/{digest}.mp3"
    return KieTtsResult(
        audio_url=url, task_id=f"fake-tts-{digest}", model=model, all_urls=[url]
    )


class KieTtsClient:
    """Thin async wrapper around Kie.ai's ElevenLabs TTS (unified Jobs API).

    Stateless: the per-call ``httpx.AsyncClient`` is opened inside each public
    method. Pass a ``transport`` (``httpx.MockTransport``) to drive it in tests
    without monkeypatching ``httpx`` globally, like the sibling kie clients.
    """

    def __init__(
        self,
        api_key: str | None = None,
        *,
        model: str | None = None,
        timeout_s: float = 120.0,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self.fake = get_settings().fake_render
        resolved = api_key or get_settings().kie_ai_api_key
        if not resolved and not self.fake:
            raise RuntimeError(
                "KIE_AI_API_KEY not configured -- set it in the worker .env "
                "before synthesizing voiceover."
            )
        self.api_key = resolved or "fake-render-no-key"
        self.model = (model or DEFAULT_TTS_MODEL).strip() or DEFAULT_TTS_MODEL
        self.timeout_s = timeout_s
        self._transport = transport

    # ------------------------------------------------------------------
    # High-level public surface
    # ------------------------------------------------------------------

    async def synthesize(
        self,
        text: str,
        *,
        voice: str,
        model: str | None = None,
        speed: float = 1.0,
        language_code: str | None = None,
        stability: float | None = None,
        similarity_boost: float | None = None,
        style: float | None = None,
        callback_url: str | None = None,
    ) -> KieTtsResult:
        """Synthesize ``text`` in ``voice`` to one audio clip; submit + poll.

        Validates the text length and speed locally (clear error vs a silent
        upstream 400). ``callback_url`` is forwarded if supplied (kie fires it
        too), but this method polls to completion regardless.
        """
        model = (model or self.model).strip() or self.model
        clean = (text or "").strip()
        if not clean:
            raise KieTtsError("TTS text is empty")
        if len(clean) > MAX_TEXT_CHARS:
            raise KieTtsError(
                f"TTS text is {len(clean)} chars; max {MAX_TEXT_CHARS} "
                f"(chunk per script segment)"
            )
        if not voice:
            raise KieTtsError("TTS voice id is required")
        if not (MIN_SPEED <= speed <= MAX_SPEED):
            raise KieTtsError(
                f"TTS speed {speed} out of range [{MIN_SPEED}, {MAX_SPEED}]"
            )

        if self.fake:
            result = fake_tts_result(clean, voice, model)
            log.info("kie_tts_faked", task_id=result.task_id, model=model)
            return result

        async with self._open_client() as client:
            task_id = await self._submit(
                client,
                model=model,
                text=clean,
                voice=voice,
                speed=speed,
                language_code=language_code,
                stability=stability,
                similarity_boost=similarity_boost,
                style=style,
                callback_url=callback_url,
            )
            log.info(
                "kie_tts_submitted",
                task_id=task_id,
                model=model,
                text_chars=len(clean),
            )
            urls = await self._poll(client, task_id)

        if not urls:
            raise KieTtsError(
                f"Kie.ai TTS task {task_id} succeeded but returned no audio URLs",
                payload={"task_id": task_id},
            )
        log.info("kie_tts_completed", task_id=task_id, model=model, urls=len(urls))
        return KieTtsResult(
            audio_url=urls[0], task_id=task_id, model=model, all_urls=urls
        )

    async def download_audio(self, url: str) -> bytes:
        """Download a result clip's bytes (for the local voiceover concat)."""
        if self.fake:
            return b""
        async with self._open_client() as client:
            try:
                resp = await client.get(url)
            except httpx.HTTPError as e:
                raise KieTtsError(f"Kie.ai TTS download network error: {e}") from e
            if resp.status_code >= 400:
                raise KieTtsError(
                    f"Kie.ai TTS download responded {resp.status_code}",
                    status_code=resp.status_code,
                )
            return resp.content

    # ------------------------------------------------------------------
    # Low-level helpers (split for tests)
    # ------------------------------------------------------------------

    def _open_client(self) -> httpx.AsyncClient:
        kwargs: dict[str, Any] = {
            "timeout": self.timeout_s,
            "headers": {
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json",
            },
        }
        if self._transport is not None:
            kwargs["transport"] = self._transport
        return httpx.AsyncClient(**kwargs)

    def _build_input(
        self,
        *,
        text: str,
        voice: str,
        speed: float,
        language_code: str | None,
        stability: float | None,
        similarity_boost: float | None,
        style: float | None,
    ) -> dict[str, Any]:
        inp: dict[str, Any] = {"text": text, "voice": voice, "speed": speed}
        if language_code is not None:
            inp["language_code"] = language_code
        if stability is not None:
            inp["stability"] = stability
        if similarity_boost is not None:
            inp["similarity_boost"] = similarity_boost
        if style is not None:
            inp["style"] = style
        return inp

    async def _submit(
        self,
        client: httpx.AsyncClient,
        *,
        model: str,
        text: str,
        voice: str,
        speed: float,
        language_code: str | None,
        stability: float | None,
        similarity_boost: float | None,
        style: float | None,
        callback_url: str | None,
    ) -> str:
        body: dict[str, Any] = {
            "model": model,
            "input": self._build_input(
                text=text,
                voice=voice,
                speed=speed,
                language_code=language_code,
                stability=stability,
                similarity_boost=similarity_boost,
                style=style,
            ),
        }
        if callback_url:
            body["callBackUrl"] = callback_url
        try:
            resp = await client.post(JOBS_CREATE_TASK_URL, json=body)
        except httpx.HTTPError as e:
            raise KieTtsError(f"Kie.ai TTS submit network error: {e}") from e

        parsed = _safe_json(resp)
        if resp.status_code >= 400:
            raise KieTtsError(
                f"Kie.ai TTS submit responded {resp.status_code}",
                payload=parsed if isinstance(parsed, dict) else None,
                status_code=resp.status_code,
            )
        if not isinstance(parsed, dict) or parsed.get("code") != 200:
            raise KieTtsError(
                "Kie.ai TTS submit returned non-200 application code",
                payload=parsed if isinstance(parsed, dict) else None,
                status_code=resp.status_code,
            )
        data = parsed.get("data") or {}
        task_id = data.get("taskId")
        if not isinstance(task_id, str) or not task_id:
            raise KieTtsError(
                "Kie.ai TTS submit response missing taskId",
                payload=parsed,
                status_code=resp.status_code,
            )
        return task_id

    async def _poll(self, client: httpx.AsyncClient, task_id: str) -> list[str]:
        url = f"{JOBS_RECORD_INFO_URL}?taskId={task_id}"
        for _attempt in range(MAX_TTS_POLL_ATTEMPTS):
            try:
                resp = await client.get(url)
            except httpx.HTTPError as e:
                raise KieTtsError(
                    f"Kie.ai TTS record-info network error: {e}"
                ) from e

            parsed = _safe_json(resp)
            if resp.status_code >= 400 or not isinstance(parsed, dict):
                raise KieTtsError(
                    f"Kie.ai TTS record-info responded {resp.status_code}",
                    payload=parsed if isinstance(parsed, dict) else None,
                    status_code=resp.status_code,
                )
            data = parsed.get("data") or {}
            state = data.get("state")
            if state == "success":
                return self._extract_urls(data, parsed, task_id)
            if state == "fail":
                raise KieTtsError(
                    f"Kie.ai TTS task {task_id} failed: "
                    f"{data.get('failMsg') or data.get('failCode') or 'unknown'}",
                    payload=parsed,
                )
            await asyncio.sleep(POLL_INTERVAL_S)

        raise KieTtsError(
            f"Kie.ai TTS task {task_id} timed out after "
            f"{MAX_TTS_POLL_ATTEMPTS * POLL_INTERVAL_S:.0f}s"
        )

    @staticmethod
    def _extract_urls(
        data: dict[str, Any], full: dict[str, Any], task_id: str
    ) -> list[str]:
        """Parse the unified record-info ``resultJson`` (a JSON string)."""
        raw = data.get("resultJson") or "{}"
        try:
            result_json = json.loads(raw)
        except json.JSONDecodeError as e:
            raise KieTtsError(
                f"Kie.ai TTS resultJson not parseable: {e}", payload=full
            ) from e
        urls = result_json.get("resultUrls")
        if not isinstance(urls, list):
            return []
        return [str(u) for u in urls if isinstance(u, str)]


def _safe_json(resp: httpx.Response) -> Any:
    """Parse a response body as JSON without raising on bad shape."""
    try:
        return resp.json()
    except (ValueError, json.JSONDecodeError):
        return None
