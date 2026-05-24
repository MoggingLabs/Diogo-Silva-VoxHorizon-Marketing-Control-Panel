"""Kie.ai VIDEO generation client.

Sibling of :mod:`services.kie` (the image client). Video lives in its own module
because kie exposes video through two parallel surfaces with divergent contracts,
and keeping them apart keeps each readable:

  * **Veo (dedicated)** -- ``POST /api/v1/veo/generate`` + ``GET
    /api/v1/veo/record-info``; status is an integer ``successFlag`` and the URLs
    sit at ``data.response.resultUrls``.
  * **Unified Jobs (Market)** -- ``POST /api/v1/jobs/createTask`` + ``GET
    /api/v1/jobs/recordInfo`` (the same endpoints the image client uses); status
    is a string ``state`` and the URLs are inside ``data.resultJson`` (a JSON
    STRING that must be parsed). Used for Kling / Seedance / etc.

This module reuses :class:`services.kie.KieError` and ``API_BASE`` /
``CREATE_TASK_URL`` / ``RECORD_INFO_URL`` from the image client so the two share
one error type and one base URL. Auth, the per-call ``httpx.AsyncClient``, the
``transport`` test seam, and ``FAKE_RENDER`` short-circuit all mirror
:class:`services.kie.KieClient`.

Contract:

  - ``KieVideoClient.generate_video(prompt, model="veo3_fast",
    aspect_ratio="9x16", duration=None, image_url=None, resolution="720p",
    callback_url=None)`` submits a job, polls until done, and returns a
    :class:`KieVideoResult` carrying the final MP4 URL. The clip is NOT
    downloaded here -- the compose stage fetches it (or call
    :meth:`download_video`).
  - ``KieVideoClient.submit_video(...)`` is the callback-driven variant: it
    submits with a ``callBackUrl`` and returns the task id without polling, for
    the worker callback route to resolve later.
  - ``KieVideoClient.verify_webhook_signature(...)`` checks the HMAC-SHA256
    signature kie attaches to completion callbacks.
  - Failures raise :class:`services.kie.KieError` with the upstream payload.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
from dataclasses import dataclass, field
from typing import Any, Literal

import httpx
import structlog

from ..config import get_settings
from .kie import API_BASE, CREATE_TASK_URL, RECORD_INFO_URL, KieError


log = structlog.get_logger(__name__)


# Kie.ai video endpoint surface.
VEO_GENERATE_URL = f"{API_BASE}/api/v1/veo/generate"
VEO_RECORD_INFO_URL = f"{API_BASE}/api/v1/veo/record-info"
VEO_1080P_URL = f"{API_BASE}/api/v1/veo/get-1080p-video"
# The unified Jobs endpoints are shared with the image client.
JOBS_CREATE_TASK_URL = CREATE_TASK_URL
JOBS_RECORD_INFO_URL = RECORD_INFO_URL

# Video models. Veo runs on the dedicated endpoints; everything else runs on the
# unified Jobs API. Branching is by the ``veo3`` prefix (see ``_is_veo``).
MODEL_VEO3_FAST = "veo3_fast"
MODEL_VEO3 = "veo3"
MODEL_VEO3_LITE = "veo3_lite"
MODEL_KLING = "kling-2.6/text-to-video"
MODEL_SEEDANCE = "bytedance/seedance-1.5-pro"
DEFAULT_VIDEO_MODEL = MODEL_VEO3_FAST

_VEO_PREFIX = "veo3"

# Webhook (callback) signature headers kie attaches on completion.
WEBHOOK_SIGNATURE_HEADER = "X-Webhook-Signature"
WEBHOOK_TIMESTAMP_HEADER = "X-Webhook-Timestamp"

# Worker ratio labels -> kie colon ratios. 9x16 is the default for short-form ads.
VideoRatio = Literal["9x16", "1x1", "16x9"]
_KIE_ASPECT_RATIO: dict[str, str] = {
    "9x16": "9:16",
    "1x1": "1:1",
    "16x9": "16:9",
}

Resolution = Literal["720p", "1080p", "4k"]

# Poll cadence. Video is slow (tens of seconds to minutes), so the ceiling is
# higher than the image client's: 5s x 120 = 10 min. Tests monkeypatch these.
POLL_INTERVAL_S = 5.0
MAX_VIDEO_POLL_ATTEMPTS = 120


def _is_veo(model: str) -> bool:
    """True when ``model`` runs on the dedicated Veo endpoints."""
    return model.startswith(_VEO_PREFIX)


class KieVideoError(KieError):
    """Alias of :class:`services.kie.KieError` for video-path call sites.

    Subclass (not just an alias) so ``except KieVideoError`` is possible while
    ``except KieError`` still catches both the image and video paths.
    """


@dataclass(frozen=True)
class KieVideoResult:
    """Bundle returned by :meth:`KieVideoClient.generate_video`.

    ``video_url`` is the first (primary) result; ``all_urls`` keeps the full list
    (kie can return several). The bytes are NOT downloaded here -- the compose
    stage fetches ``video_url`` (or :meth:`KieVideoClient.download_video`).
    """

    video_url: str
    task_id: str
    model: str
    aspect_ratio: str
    resolution: str
    is_veo: bool
    all_urls: list[str] = field(default_factory=list)


def fake_video_result(
    prompt: str, model: str, aspect_ratio: str, resolution: str
) -> KieVideoResult:
    """Deterministic fake result for FAKE_RENDER mode (no network, no spend).

    The same inputs always yield the same task id + url, keeping downstream
    idempotency probes (skip-already-rendered) honest.
    """
    digest = hashlib.sha256(
        f"{prompt}|{model}|{aspect_ratio}|{resolution}".encode("utf-8")
    ).hexdigest()[:16]
    url = f"https://fake.kie.local/{digest}.mp4"
    return KieVideoResult(
        video_url=url,
        task_id=f"fake-vid-{digest}",
        model=model,
        aspect_ratio=aspect_ratio,
        resolution=resolution,
        is_veo=_is_veo(model),
        all_urls=[url],
    )


class KieVideoClient:
    """Thin async wrapper around the Kie.ai video APIs.

    Stateless: the per-call ``httpx.AsyncClient`` is opened inside each public
    method. Pass a ``transport`` (``httpx.MockTransport``) to drive it in tests
    without monkeypatching ``httpx`` globally, exactly like
    :class:`services.kie.KieClient`.
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
                "before generating video."
            )
        self.api_key = resolved or "fake-render-no-key"
        self.model = (model or DEFAULT_VIDEO_MODEL).strip() or DEFAULT_VIDEO_MODEL
        self.timeout_s = timeout_s
        self._transport = transport

    # ------------------------------------------------------------------
    # High-level public surface
    # ------------------------------------------------------------------

    async def generate_video(
        self,
        prompt: str,
        *,
        model: str | None = None,
        aspect_ratio: VideoRatio = "9x16",
        duration: int | str | None = None,
        image_url: str | None = None,
        resolution: Resolution = "720p",
        callback_url: str | None = None,
    ) -> KieVideoResult:
        """Submit a video job, poll until done, and return the result URL.

        Synchronous convenience (submit + poll). For the callback-driven path
        that does not block on a poll, use :meth:`submit_video` plus the worker
        callback route. ``callback_url`` is still forwarded here if supplied (kie
        will fire it too), but this method also polls to completion.
        """
        model = (model or self.model).strip() or self.model
        aspect = self._resolve_ratio(aspect_ratio)

        if self.fake:
            result = fake_video_result(prompt, model, aspect, resolution)
            log.info(
                "kie_video_faked",
                task_id=result.task_id,
                model=model,
                aspect_ratio=aspect,
            )
            return result

        async with self._open_client() as client:
            task_id, is_veo = await self._submit(
                client,
                model=model,
                prompt=prompt,
                aspect_ratio=aspect,
                duration=duration,
                image_url=image_url,
                resolution=resolution,
                callback_url=callback_url,
            )
            log.info(
                "kie_video_submitted",
                task_id=task_id,
                model=model,
                aspect_ratio=aspect,
                is_veo=is_veo,
                prompt_chars=len(prompt),
            )
            urls = await self._poll(client, task_id, is_veo)

        if not urls:
            raise KieVideoError(
                f"Kie.ai video task {task_id} succeeded but returned no URLs",
                payload={"task_id": task_id},
            )
        log.info("kie_video_completed", task_id=task_id, model=model, urls=len(urls))
        return KieVideoResult(
            video_url=urls[0],
            task_id=task_id,
            model=model,
            aspect_ratio=aspect,
            resolution=resolution,
            is_veo=is_veo,
            all_urls=urls,
        )

    async def submit_video(
        self,
        prompt: str,
        *,
        callback_url: str,
        model: str | None = None,
        aspect_ratio: VideoRatio = "9x16",
        duration: int | str | None = None,
        image_url: str | None = None,
        resolution: Resolution = "720p",
    ) -> tuple[str, bool]:
        """Submit a video job with a callback and return ``(task_id, is_veo)``.

        The callback-driven path: kie POSTs ``callback_url`` on completion (the
        worker route verifies the signature with
        :meth:`verify_webhook_signature` and resolves the result). No polling.
        """
        model = (model or self.model).strip() or self.model
        aspect = self._resolve_ratio(aspect_ratio)
        if self.fake:
            return fake_video_result(prompt, model, aspect, resolution).task_id, _is_veo(model)
        async with self._open_client() as client:
            return await self._submit(
                client,
                model=model,
                prompt=prompt,
                aspect_ratio=aspect,
                duration=duration,
                image_url=image_url,
                resolution=resolution,
                callback_url=callback_url,
            )

    async def download_video(self, url: str) -> bytes:
        """Download a result clip's bytes (for the local compose stage)."""
        if self.fake:
            return b""
        async with self._open_client() as client:
            try:
                resp = await client.get(url)
            except httpx.HTTPError as e:
                raise KieVideoError(f"Kie.ai video download network error: {e}") from e
            if resp.status_code >= 400:
                raise KieVideoError(
                    f"Kie.ai video download responded {resp.status_code}",
                    status_code=resp.status_code,
                )
            return resp.content

    @staticmethod
    def verify_webhook_signature(
        task_id: str, timestamp: str, signature: str, secret: str
    ) -> bool:
        """Verify a kie completion-callback signature (HMAC-SHA256, Base64).

        kie signs ``f"{taskId}.{timestamp}"`` with the account ``webhookHmacKey``
        and sends the Base64 digest in ``X-Webhook-Signature`` (timestamp in
        ``X-Webhook-Timestamp``). Constant-time compare.
        """
        if not (task_id and timestamp and signature and secret):
            return False
        expected = base64.b64encode(
            hmac.new(
                secret.encode("utf-8"),
                f"{task_id}.{timestamp}".encode("utf-8"),
                hashlib.sha256,
            ).digest()
        ).decode("ascii")
        return hmac.compare_digest(expected, signature)

    # ------------------------------------------------------------------
    # Low-level helpers (split for tests)
    # ------------------------------------------------------------------

    def _resolve_ratio(self, ratio: str) -> str:
        kie = _KIE_ASPECT_RATIO.get(ratio)
        if kie is None:
            raise KieVideoError(
                f"Unsupported aspect_ratio: {ratio!r} "
                f"(supported: {sorted(_KIE_ASPECT_RATIO)})"
            )
        return kie

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

    def _build_submit(
        self,
        *,
        model: str,
        prompt: str,
        aspect_ratio: str,
        duration: int | str | None,
        image_url: str | None,
        resolution: str,
        callback_url: str | None,
    ) -> tuple[str, dict[str, Any]]:
        """Return ``(submit_url, body)`` for the model's API surface."""
        if _is_veo(model):
            body: dict[str, Any] = {
                "prompt": prompt,
                "model": model,
                "aspect_ratio": aspect_ratio,
                "resolution": resolution,
            }
            if image_url:
                body["imageUrls"] = [image_url]
                body["generationType"] = "REFERENCE_2_VIDEO"
            if callback_url:
                body["callBackUrl"] = callback_url
            return VEO_GENERATE_URL, body

        # Unified Jobs API (Kling / Seedance / ...). Params nest under ``input``.
        inp: dict[str, Any] = {"prompt": prompt, "aspect_ratio": aspect_ratio}
        if duration is not None:
            inp["duration"] = str(duration)
        if image_url:
            # Seedance uses ``input_urls``; the others use ``imageUrls``.
            inp["input_urls" if "seedance" in model else "imageUrls"] = [image_url]
        if "seedance" in model:
            # Only Seedance documents a resolution field on the unified input;
            # passing unknown fields to other models risks a 400.
            inp["resolution"] = resolution
        body = {"model": model, "input": inp}
        if callback_url:
            body["callBackUrl"] = callback_url
        return JOBS_CREATE_TASK_URL, body

    async def _submit(
        self,
        client: httpx.AsyncClient,
        *,
        model: str,
        prompt: str,
        aspect_ratio: str,
        duration: int | str | None,
        image_url: str | None,
        resolution: str,
        callback_url: str | None,
    ) -> tuple[str, bool]:
        submit_url, body = self._build_submit(
            model=model,
            prompt=prompt,
            aspect_ratio=aspect_ratio,
            duration=duration,
            image_url=image_url,
            resolution=resolution,
            callback_url=callback_url,
        )
        try:
            resp = await client.post(submit_url, json=body)
        except httpx.HTTPError as e:
            raise KieVideoError(f"Kie.ai video submit network error: {e}") from e

        parsed = _safe_json(resp)
        if resp.status_code >= 400:
            raise KieVideoError(
                f"Kie.ai video submit responded {resp.status_code}",
                payload=parsed if isinstance(parsed, dict) else None,
                status_code=resp.status_code,
            )
        if not isinstance(parsed, dict) or parsed.get("code") != 200:
            raise KieVideoError(
                "Kie.ai video submit returned non-200 application code",
                payload=parsed if isinstance(parsed, dict) else None,
                status_code=resp.status_code,
            )
        data = parsed.get("data") or {}
        task_id = data.get("taskId")
        if not isinstance(task_id, str) or not task_id:
            raise KieVideoError(
                "Kie.ai video submit response missing taskId",
                payload=parsed,
                status_code=resp.status_code,
            )
        return task_id, _is_veo(model)

    async def _poll(
        self, client: httpx.AsyncClient, task_id: str, is_veo: bool
    ) -> list[str]:
        """Poll until completion and return the result URLs.

        Veo and the unified API report status differently (``successFlag`` int vs
        ``state`` string) and put the URLs in different places. Unlike the image
        poll, this does NOT hard-fail on the application ``code`` field: the
        unified record-info endpoint is documented to sometimes return a non-200
        ``code`` on an otherwise-successful body, so we gate on the status field
        and the HTTP status only.
        """
        url = (
            f"{VEO_RECORD_INFO_URL}?taskId={task_id}"
            if is_veo
            else f"{JOBS_RECORD_INFO_URL}?taskId={task_id}"
        )
        for _attempt in range(MAX_VIDEO_POLL_ATTEMPTS):
            try:
                resp = await client.get(url)
            except httpx.HTTPError as e:
                raise KieVideoError(f"Kie.ai video record-info network error: {e}") from e

            parsed = _safe_json(resp)
            if resp.status_code >= 400 or not isinstance(parsed, dict):
                raise KieVideoError(
                    f"Kie.ai video record-info responded {resp.status_code}",
                    payload=parsed if isinstance(parsed, dict) else None,
                    status_code=resp.status_code,
                )
            data = parsed.get("data") or {}

            if is_veo:
                flag = data.get("successFlag")
                if flag == 1:
                    block = data.get("response") or {}
                    urls = block.get("resultUrls") or block.get("originUrls") or []
                    return [str(u) for u in urls if isinstance(u, str)]
                if flag in (2, 3):
                    raise KieVideoError(
                        f"Kie.ai Veo task {task_id} failed: "
                        f"{data.get('errorMessage') or 'unknown error'}",
                        payload=parsed,
                    )
            else:
                state = data.get("state")
                if state == "success":
                    return self._extract_unified_urls(data, parsed, task_id)
                if state == "fail":
                    raise KieVideoError(
                        f"Kie.ai task {task_id} failed: "
                        f"{data.get('failMsg') or data.get('failCode') or 'unknown'}",
                        payload=parsed,
                    )

            await asyncio.sleep(POLL_INTERVAL_S)

        raise KieVideoError(
            f"Kie.ai video task {task_id} timed out after "
            f"{MAX_VIDEO_POLL_ATTEMPTS * POLL_INTERVAL_S:.0f}s"
        )

    @staticmethod
    def _extract_unified_urls(
        data: dict[str, Any], full: dict[str, Any], task_id: str
    ) -> list[str]:
        """Parse the unified record-info ``resultJson`` (a JSON string)."""
        raw = data.get("resultJson") or "{}"
        try:
            result_json = json.loads(raw)
        except json.JSONDecodeError as e:
            raise KieVideoError(
                f"Kie.ai resultJson not parseable: {e}", payload=full
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
