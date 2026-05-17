"""Submagic captioning client.

V2-7 ships this as an async, polling wrapper over the Submagic REST API.
The API is fundamentally asynchronous: you submit a job (``POST /projects``),
poll the project status until ``status == "completed"``, then download the
finished MP4 from the ``video_url`` field.

Style ids and the project flow are stable across the May 2026 product:

    POST   /v1/projects            { video_url, template_id?, ... } → { project_id }
    GET    /v1/projects/{id}       → { status, video_url?, error? }

Two notes on the wrapper:

1. We deliberately accept a public URL (not bytes) on the input side. The
   caller is responsible for making the composed MP4 reachable — usually
   via a Supabase Storage signed URL. That avoids streaming gigabytes
   through the worker on every iteration.

2. We download the captioned MP4 ourselves rather than handing the URL
   back to the route, because Submagic's CDN URLs expire and we want the
   route to persist final bytes into our own Storage with our retention.

This module never touches Supabase or ffmpeg. It's a thin transport so
the route layer composes "upload to Storage" + "Submagic.caption" + "save
result" itself.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any

import httpx
import structlog

from ..config import get_settings


log = structlog.get_logger(__name__)


# Submagic base URL. The May 2026 product uses ``api.submagic.co`` for
# both project creation and status polling.
SUBMAGIC_BASE_URL = "https://api.submagic.co/v1"


# Map our internal captions style ids onto Submagic template ids. The
# Submagic dashboard exposes a numeric id per template; these are the
# three we use across the catalogue.
#
# When we add a new style, mirror it in the Next.js side (the operator
# picks from this list in the brief form).
STYLE_TEMPLATE_IDS: dict[str, str] = {
    "bold_yellow": "hormozi-yellow",
    "minimal_white": "minimal-white",
    "brand": "hormozi-yellow",  # v1 brand styling reuses bold_yellow
}


# Default polling cadence. Submagic typically finishes a 30s video in
# ~30-60s, so we poll every 5s up to 6 minutes. The route can override.
DEFAULT_POLL_INTERVAL_S = 5.0
DEFAULT_POLL_TIMEOUT_S = 6 * 60.0


@dataclass(frozen=True)
class SubmagicJobResult:
    """Captioning outcome the route layer cares about."""

    project_id: str
    video_url: str
    captioned_bytes: bytes


class SubmagicClient:
    """Tiny async polling client.

    Usage::

        async with SubmagicClient() as client:
            result = await client.caption(public_url, style="bold_yellow")

        # result.captioned_bytes is the final MP4 — write it to Storage.
    """

    def __init__(
        self,
        *,
        api_key: str | None = None,
        timeout_s: float = 30.0,
        client: httpx.AsyncClient | None = None,
        base_url: str = SUBMAGIC_BASE_URL,
    ) -> None:
        settings = get_settings()
        self.api_key = api_key or settings.submagic_api_key
        if not self.api_key:
            raise RuntimeError(
                "SUBMAGIC_API_KEY is not configured — captioning is unavailable."
            )
        self.timeout_s = timeout_s
        self.base_url = base_url.rstrip("/")
        self._owned_client = client is None
        # We use a generous default read timeout: Submagic's download
        # endpoint can stream slowly for larger jobs.
        self._client = client or httpx.AsyncClient(timeout=timeout_s)

    async def close(self) -> None:
        if self._owned_client:
            await self._client.aclose()

    async def __aenter__(self) -> "SubmagicClient":
        return self

    async def __aexit__(self, *_: object) -> None:
        await self.close()

    def _auth_headers(self) -> dict[str, str]:
        return {"x-api-key": self.api_key, "accept": "application/json"}

    async def submit(
        self,
        video_url: str,
        *,
        style: str,
        language: str = "en",
        extra: dict[str, Any] | None = None,
    ) -> str:
        """POST a captioning job and return the project id.

        ``style`` is one of our keys in :data:`STYLE_TEMPLATE_IDS`. Unknown
        styles fall back to ``bold_yellow`` rather than raising — the
        brief form already validates the enum and we'd rather hand the
        operator a captioned video with the default template than fail
        the whole pipeline.
        """
        template_id = STYLE_TEMPLATE_IDS.get(style, STYLE_TEMPLATE_IDS["bold_yellow"])
        body: dict[str, Any] = {
            "video_url": video_url,
            "template_id": template_id,
            "language": language,
        }
        if extra:
            body.update(extra)

        resp = await self._client.post(
            f"{self.base_url}/projects",
            headers={**self._auth_headers(), "content-type": "application/json"},
            json=body,
        )
        if resp.status_code >= 400:
            raise RuntimeError(
                f"Submagic submit failed ({resp.status_code}): {resp.text[:500]}"
            )
        payload = resp.json()
        project_id = payload.get("id") or payload.get("project_id")
        if not isinstance(project_id, str):
            raise RuntimeError(f"Submagic submit returned no id: {payload!r}")
        return project_id

    async def poll(self, project_id: str) -> dict[str, Any]:
        """GET the project status; raw payload returned for caller use."""
        resp = await self._client.get(
            f"{self.base_url}/projects/{project_id}",
            headers=self._auth_headers(),
        )
        if resp.status_code >= 400:
            raise RuntimeError(
                f"Submagic poll failed ({resp.status_code}): {resp.text[:500]}"
            )
        payload = resp.json()
        if not isinstance(payload, dict):
            raise RuntimeError(f"Submagic poll returned non-object: {payload!r}")
        return payload

    async def download(self, video_url: str) -> bytes:
        """GET the final MP4 from the CDN URL Submagic returned."""
        resp = await self._client.get(video_url)
        if resp.status_code >= 400:
            raise RuntimeError(
                f"Submagic download failed ({resp.status_code}): {video_url}"
            )
        return resp.content

    async def caption(
        self,
        video_url: str,
        *,
        style: str,
        poll_interval_s: float = DEFAULT_POLL_INTERVAL_S,
        poll_timeout_s: float = DEFAULT_POLL_TIMEOUT_S,
    ) -> SubmagicJobResult:
        """Submit + poll + download. Returns the final MP4 bytes.

        Raises ``RuntimeError`` if the job fails or the timeout expires.
        The default 6-minute timeout is generous — a 30s ad usually
        captions in under 60s — but Submagic can stall on weekends.
        """
        project_id = await self.submit(video_url, style=style)
        log.info("submagic_submitted", project_id=project_id, style=style)

        elapsed = 0.0
        last_status: str | None = None
        while elapsed < poll_timeout_s:
            status_payload = await self.poll(project_id)
            status = str(status_payload.get("status") or "").lower()
            last_status = status

            if status in ("completed", "done", "succeeded"):
                final_url = status_payload.get("video_url") or status_payload.get(
                    "output_url"
                )
                if not isinstance(final_url, str):
                    raise RuntimeError(
                        f"Submagic project {project_id} completed without "
                        f"video_url: {status_payload!r}"
                    )
                content = await self.download(final_url)
                log.info(
                    "submagic_completed",
                    project_id=project_id,
                    bytes=len(content),
                    elapsed_s=elapsed,
                )
                return SubmagicJobResult(
                    project_id=project_id,
                    video_url=final_url,
                    captioned_bytes=content,
                )
            if status in ("failed", "error", "canceled", "cancelled"):
                err = status_payload.get("error") or status_payload
                raise RuntimeError(
                    f"Submagic project {project_id} failed: {err!r}"
                )

            await asyncio.sleep(poll_interval_s)
            elapsed += poll_interval_s

        raise RuntimeError(
            f"Submagic project {project_id} timed out after {poll_timeout_s:.0f}s "
            f"(last status: {last_status!r})"
        )


__all__ = [
    "SubmagicClient",
    "SubmagicJobResult",
    "SUBMAGIC_BASE_URL",
    "STYLE_TEMPLATE_IDS",
    "DEFAULT_POLL_INTERVAL_S",
    "DEFAULT_POLL_TIMEOUT_S",
]
