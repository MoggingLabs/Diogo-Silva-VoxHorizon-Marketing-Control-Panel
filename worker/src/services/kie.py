"""Kie.ai REST API client wrapper.

Generates Meta-ready ad images via the Nano Banana 2 model on Kie.ai. The
upstream CLI lives at ``~/github/voxhorizon-marketing-dept/scripts/creative-tools/kie_generate.py``;
this module mirrors its API contract but speaks ``httpx`` so the worker can
await it natively and keep the per-brief queue serialized.

Contract:

  - ``KieClient.generate_image(prompt, ratio="1x1"|"9x16", resolution="2K")``
    submits a task and polls until ``state == "success"``, then downloads
    the result and returns the raw PNG/JPEG bytes.
  - Sequential per brief is the caller's responsibility (the per-brief
    ``BriefQueue`` enforces it at the route layer).
  - Failures raise :class:`KieError` with the upstream payload.

The API key resolves from ``Settings.kie_ai_api_key`` (env ``KIE_AI_API_KEY``)
unless the caller passes one explicitly. We deliberately do NOT fall back to
``~/.hermes/shared/config/secrets.json`` the way the CLI does — the worker
runs as a service and the env var is the single source of truth.
"""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass
from typing import Any, Literal

import httpx
import structlog

from ..config import get_settings


log = structlog.get_logger(__name__)


# Kie.ai endpoint surface.
API_BASE = "https://api.kie.ai"
CREATE_TASK_URL = f"{API_BASE}/api/v1/jobs/createTask"
RECORD_INFO_URL = f"{API_BASE}/api/v1/jobs/recordInfo"

# Defaults — same as the upstream CLI so the two paths produce identical
# images for the same prompt.
MODEL = "nano-banana-2"

# Poll cadence: every 5s, up to 5 minutes total. Kie.ai's nano-banana-2
# typically finishes in 30–90s; the 5-min ceiling exists to surface a
# stuck task rather than wait forever.
POLL_INTERVAL_S = 5.0
MAX_POLL_ATTEMPTS = 60

# We accept the worker-side "1x1" / "9x16" labels and translate to the
# Kie-side colon-separated ratios at submission time. Keep this table tight
# to the two ratios the SOP supports — anything else is a 400.
Ratio = Literal["1x1", "9x16"]
_KIE_ASPECT_RATIO: dict[Ratio, str] = {
    "1x1": "1:1",
    "9x16": "9:16",
}

Resolution = Literal["1K", "2K", "4K"]


class KieError(RuntimeError):
    """Raised on any failure from Kie.ai — submit, poll, or download.

    ``payload`` is the parsed JSON body when one was returned; ``None`` for
    network / timeout failures. ``status_code`` is set when the failure
    originated in an HTTP response.
    """

    def __init__(
        self,
        message: str,
        *,
        payload: dict[str, Any] | None = None,
        status_code: int | None = None,
    ) -> None:
        super().__init__(message)
        self.payload = payload
        self.status_code = status_code


@dataclass(frozen=True)
class KieGenerationResult:
    """Bundle returned by :meth:`KieClient.generate_image_full`.

    Most callers want :meth:`KieClient.generate_image` and just take the
    bytes; this richer shape is exposed for tests and the chat-iterate
    flow which wants the ``task_id`` and ``source_url`` for the iteration
    audit log.
    """

    image_bytes: bytes
    task_id: str
    source_url: str
    aspect_ratio: str
    resolution: str


class KieClient:
    """Thin async wrapper around the Kie.ai REST API.

    The client is stateless; the per-call ``httpx.AsyncClient`` is opened
    inside each public method so we don't carry a long-lived connection
    pool across worker requests. Callers that want pooling should construct
    a single client and pass an ``httpx.AsyncClient`` via the ``transport``
    kwarg (testing seam).
    """

    def __init__(
        self,
        api_key: str | None = None,
        *,
        timeout_s: float = 60.0,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        # Resolve at construction time so the failure mode is loud + early.
        resolved = api_key or get_settings().kie_ai_api_key
        if not resolved:
            raise RuntimeError(
                "KIE_AI_API_KEY not configured — set it in the worker .env "
                "before calling /work/creative/generate."
            )
        self.api_key = resolved
        self.timeout_s = timeout_s
        self._transport = transport

    # ------------------------------------------------------------------
    # High-level public surface
    # ------------------------------------------------------------------

    async def generate_image(
        self,
        prompt: str,
        ratio: Ratio,
        *,
        resolution: Resolution = "2K",
    ) -> bytes:
        """Generate one image and return the raw bytes.

        Returns the PNG/JPEG bytes of the first ``resultUrls`` entry. The
        caller is responsible for uploading to Supabase Storage and
        recording the row.
        """
        result = await self.generate_image_full(
            prompt,
            ratio,
            resolution=resolution,
        )
        return result.image_bytes

    async def generate_image_full(
        self,
        prompt: str,
        ratio: Ratio,
        *,
        resolution: Resolution = "2K",
    ) -> KieGenerationResult:
        """Generate one image; return bytes + provenance metadata.

        Exposes ``task_id`` and ``source_url`` so the iteration row in
        Supabase can store them and the operator can trace a creative
        back to the exact Kie.ai task.
        """
        if ratio not in _KIE_ASPECT_RATIO:
            raise KieError(f"Unsupported ratio: {ratio!r} (must be 1x1 or 9x16)")

        aspect = _KIE_ASPECT_RATIO[ratio]

        async with self._open_client() as client:
            task_id = await self._create_task(
                client,
                prompt=prompt,
                aspect_ratio=aspect,
                resolution=resolution,
            )
            log.info(
                "kie_task_submitted",
                task_id=task_id,
                aspect_ratio=aspect,
                resolution=resolution,
                prompt_chars=len(prompt),
            )

            urls = await self._poll_task(client, task_id)
            if not urls:
                raise KieError(
                    f"Kie.ai task {task_id} succeeded but returned no resultUrls",
                    payload={"task_id": task_id},
                )

            source_url = urls[0]
            image_bytes = await self._download_image(client, source_url)

        log.info(
            "kie_task_completed",
            task_id=task_id,
            aspect_ratio=aspect,
            resolution=resolution,
            byte_count=len(image_bytes),
        )

        return KieGenerationResult(
            image_bytes=image_bytes,
            task_id=task_id,
            source_url=source_url,
            aspect_ratio=aspect,
            resolution=resolution,
        )

    # ------------------------------------------------------------------
    # Low-level helpers (split for tests)
    # ------------------------------------------------------------------

    def _open_client(self) -> httpx.AsyncClient:
        """Build the per-call ``httpx.AsyncClient``.

        Split into a method so tests can substitute a ``MockTransport``
        via ``KieClient(..., transport=...)`` without monkey-patching
        ``httpx`` globally.
        """
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

    async def _create_task(
        self,
        client: httpx.AsyncClient,
        *,
        prompt: str,
        aspect_ratio: str,
        resolution: str,
    ) -> str:
        payload = {
            "model": MODEL,
            "input": {
                "prompt": prompt,
                "image_input": [],
                "aspect_ratio": aspect_ratio,
                "resolution": resolution,
            },
        }
        try:
            resp = await client.post(CREATE_TASK_URL, json=payload)
        except httpx.HTTPError as e:
            raise KieError(f"Kie.ai createTask network error: {e}") from e

        body = _safe_json(resp)
        if resp.status_code >= 400:
            raise KieError(
                f"Kie.ai createTask responded {resp.status_code}",
                payload=body,
                status_code=resp.status_code,
            )
        if not isinstance(body, dict) or body.get("code") != 200:
            raise KieError(
                "Kie.ai createTask returned non-200 application code",
                payload=body,
                status_code=resp.status_code,
            )
        data = body.get("data") or {}
        task_id = data.get("taskId")
        if not isinstance(task_id, str) or not task_id:
            raise KieError(
                "Kie.ai createTask response missing taskId",
                payload=body,
                status_code=resp.status_code,
            )
        return task_id

    async def _poll_task(
        self,
        client: httpx.AsyncClient,
        task_id: str,
    ) -> list[str]:
        """Poll until ``state == "success"`` and return the result URLs."""
        url = f"{RECORD_INFO_URL}?taskId={task_id}"
        for attempt in range(MAX_POLL_ATTEMPTS):
            try:
                resp = await client.get(url)
            except httpx.HTTPError as e:
                raise KieError(f"Kie.ai recordInfo network error: {e}") from e

            body = _safe_json(resp)
            if resp.status_code >= 400 or not isinstance(body, dict):
                raise KieError(
                    f"Kie.ai recordInfo responded {resp.status_code}",
                    payload=body if isinstance(body, dict) else None,
                    status_code=resp.status_code,
                )
            if body.get("code") != 200:
                raise KieError(
                    "Kie.ai recordInfo returned non-200 application code",
                    payload=body,
                    status_code=resp.status_code,
                )

            data = body.get("data") or {}
            state = data.get("state")
            if state == "success":
                result_json_raw = data.get("resultJson") or "{}"
                try:
                    result_json = json.loads(result_json_raw)
                except json.JSONDecodeError as e:
                    raise KieError(
                        f"Kie.ai resultJson not parseable: {e}",
                        payload=body,
                    ) from e
                urls = result_json.get("resultUrls")
                if not isinstance(urls, list):
                    return []
                return [str(u) for u in urls if isinstance(u, str)]
            if state in ("failed", "error"):
                raise KieError(
                    f"Kie.ai task {task_id} failed: "
                    f"{data.get('failMsg', 'unknown error')}",
                    payload=body,
                )

            await asyncio.sleep(POLL_INTERVAL_S)

        raise KieError(
            f"Kie.ai task {task_id} timed out after "
            f"{MAX_POLL_ATTEMPTS * POLL_INTERVAL_S:.0f}s"
        )

    async def _download_image(self, client: httpx.AsyncClient, url: str) -> bytes:
        try:
            resp = await client.get(url)
        except httpx.HTTPError as e:
            raise KieError(f"Kie.ai image download network error: {e}") from e

        if resp.status_code >= 400:
            raise KieError(
                f"Kie.ai image download responded {resp.status_code}",
                status_code=resp.status_code,
            )
        return resp.content


def _safe_json(resp: httpx.Response) -> Any:
    """Parse a response body as JSON without raising on bad shape."""
    try:
        return resp.json()
    except (ValueError, json.JSONDecodeError):
        return None
