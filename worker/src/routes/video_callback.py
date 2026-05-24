"""Kie.ai video completion-callback receiver (E5.2 / #514).

THE BUG this closes: the live broll-search path submits a kie video render and
then BLOCKS on a 10-minute poll (``services.kie_video.generate_video``). The
submitted ``taskId`` was never persisted and NO route consumed kie's completion
callback, so a worker restart mid-poll abandoned the render -- kie still produced
(and billed) the clip, but nothing downloaded or recorded it.

This module is the missing callback receiver. kie POSTs here on completion with
the result + an HMAC-SHA256 signature; we:

  1. verify the signature via the existing
     :meth:`services.kie_video.KieVideoClient.verify_webhook_signature` (reading
     the shared secret from config) -- a bad/absent signature is rejected;
  2. look up the in-flight render in ``video_render_tasks`` by ``task_id``
     (the durable record migration 0033 adds);
  3. download the result clip + store it in the b-roll pool, mirroring the
     polling path's completion handling in ``routes.video.search_broll``;
  4. mark the render terminal (``completed`` / ``failed``).

Idempotency + never-5xx: a duplicate or late callback for an already-terminal
render is a 200 no-op (``deduped: true``) -- it NEVER re-downloads, NEVER
re-bills, and NEVER 5xxes (kie retries on a 5xx, which would amplify the
problem). The same ``task_id`` uniqueness that makes this idempotent also lets
the reconciliation sweep (``services.scheduler.run_kie_reconcile_once``) and the
callback race safely: whichever resolves the render first wins; the loser sees a
terminal row and no-ops. The dedupe pattern mirrors the GHL webhook inbox in
``routes.integrations`` (probe-then-act on a unique key, drop a replay).

This route is deliberately NOT bearer-authed (kie cannot present the worker's
shared secret); the HMAC signature IS its auth.
"""

from __future__ import annotations

import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import structlog
from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel

from ..config import get_settings
from ..services.broll_store import get_broll_store
from ..services.kie_video import (
    WEBHOOK_SIGNATURE_HEADER,
    WEBHOOK_TIMESTAMP_HEADER,
    KieVideoClient,
)
from ..supabase_client import get_supabase_admin


log = structlog.get_logger(__name__)


router = APIRouter()


RENDER_TASKS_TABLE = "video_render_tasks"


class KieCallbackBody(BaseModel):
    """kie completion-callback body. Free-shape -- kie's payload varies by model.

    We only require the ``task_id`` (read from any of the shapes kie uses) and
    optionally the result URLs; everything else is kept for the audit row.
    """

    model_config = {"extra": "allow"}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _extract_task_id(body: dict[str, Any]) -> str | None:
    """Pull the kie task id out of the callback body (tolerant of shape).

    kie surfaces the id as ``taskId`` (camel) at the top level or nested under
    ``data``; accept ``task_id`` too for forward-compat.
    """
    for key in ("taskId", "task_id"):
        val = body.get(key)
        if isinstance(val, str) and val:
            return val
    data = body.get("data")
    if isinstance(data, dict):
        for key in ("taskId", "task_id"):
            val = data.get(key)
            if isinstance(val, str) and val:
                return val
    return None


def _extract_result_urls(body: dict[str, Any]) -> list[str]:
    """Pull the result clip URLs out of a kie callback body (best-effort).

    Mirrors the URL locations the poll path reads: Veo nests them under
    ``data.response.resultUrls`` (or ``originUrls``); the unified API under
    ``data.resultUrls``. Also accepts a top-level ``resultUrls``.
    """
    candidates: list[Any] = []
    data = body.get("data") if isinstance(body.get("data"), dict) else {}
    response = data.get("response") if isinstance(data.get("response"), dict) else {}
    for src in (
        response.get("resultUrls"),
        response.get("originUrls"),
        data.get("resultUrls"),
        body.get("resultUrls"),
    ):
        if isinstance(src, list):
            candidates = src
            break
    return [str(u) for u in candidates if isinstance(u, str) and u]


def _fetch_render_task(task_id: str) -> dict[str, Any] | None:
    sb = get_supabase_admin()
    resp = (
        sb.table(RENDER_TASKS_TABLE)
        .select("*")
        .eq("task_id", task_id)
        .maybe_single()
        .execute()
    )
    return resp.data if (resp is not None and isinstance(resp.data, dict)) else None


async def _store_render_result(
    *, task_id: str, theme: str | None, urls: list[str]
) -> dict[str, Any]:
    """Download the first result clip + store it in the b-roll pool.

    Mirrors ``routes.video.search_broll``'s completion handling: download the
    clip bytes, write to a temp file, ``store.put`` (content-hash dedup), and
    return the stored-clip dict. The pool put is idempotent on the content hash,
    so even a re-download (should the row guard ever be bypassed) re-uses the
    on-disk copy rather than duplicating it.
    """
    if not urls:
        raise HTTPException(
            status_code=422, detail=f"kie callback for {task_id} carried no result URL"
        )
    video_client = KieVideoClient()
    store = get_broll_store()
    primary = urls[0]
    data = await video_client.download_video(primary)
    tmp = Path(tempfile.mkdtemp(prefix="vox-cb-")) / f"{task_id}.mp4"
    tmp.write_bytes(data)
    stored = await store.put(primary, tmp, theme=theme or None)
    return stored.to_dict()


def _mark_completed(task_id: str, *, result_url: str, clip_id: str | None) -> None:
    sb = get_supabase_admin()
    sb.table(RENDER_TASKS_TABLE).update(
        {
            "status": "completed",
            "result_url": result_url,
            "clip_id": clip_id,
            "completed_at": _now_iso(),
        }
    ).eq("task_id", task_id).execute()


@router.post("/work/video/kie-callback")
async def kie_video_callback(
    body: KieCallbackBody,
    x_webhook_signature: str | None = Header(default=None, alias=WEBHOOK_SIGNATURE_HEADER),
    x_webhook_timestamp: str | None = Header(default=None, alias=WEBHOOK_TIMESTAMP_HEADER),
) -> dict[str, Any]:
    """Receive a kie video completion callback, verify it, record the result.

    Auth is the HMAC signature (kie cannot present the worker bearer). Order:
    (1) extract + verify the signature over ``f"{taskId}.{timestamp}"``; a bad
    or unverifiable signature 401s; (2) look up the in-flight render; an unknown
    task 404s (kie won't retry a 404 forever, and there's nothing to record);
    (3) if the render is ALREADY terminal, no-op + 200 (idempotent -- duplicate /
    late callback); (4) otherwise download + store the result, mark the row
    terminal, and 200. NEVER 5xxes on a duplicate/late callback.
    """
    payload: dict[str, Any] = dict(body.model_dump())

    task_id = _extract_task_id(payload)
    if not task_id:
        raise HTTPException(status_code=422, detail="kie callback missing taskId")

    secret = get_settings().kie_ai_webhook_secret
    if not secret:
        # Cannot verify without the key -- refuse rather than trust an unsigned
        # body. 503 (config gap), and the reconciliation sweep recovers the
        # render durably from video_render_tasks regardless.
        log.error("kie_callback_no_secret_configured", task_id=task_id)
        raise HTTPException(
            status_code=503, detail="kie webhook secret not configured"
        )

    if not KieVideoClient.verify_webhook_signature(
        task_id, x_webhook_timestamp or "", x_webhook_signature or "", secret
    ):
        log.warning("kie_callback_bad_signature", task_id=task_id)
        raise HTTPException(status_code=401, detail="invalid kie webhook signature")

    task = _fetch_render_task(task_id)
    if task is None:
        log.warning("kie_callback_unknown_task", task_id=task_id)
        raise HTTPException(status_code=404, detail=f"unknown render task: {task_id}")

    # (3) Idempotent: an already-terminal render is a 200 no-op. This is the
    # never-re-download / never-re-bill guard AND the duplicate-callback guard.
    if task.get("status") in ("completed", "failed"):
        log.info("kie_callback_duplicate", task_id=task_id, status=task.get("status"))
        return {
            "ok": True,
            "deduped": True,
            "task_id": task_id,
            "status": task.get("status"),
        }

    # (4) Resolve the result. A callback can also report a failure -- record it
    # terminal so the sweep never re-polls a dead render.
    sb = get_supabase_admin()
    state = _callback_state(payload)
    if state == "failed":
        sb.table(RENDER_TASKS_TABLE).update(
            {
                "status": "failed",
                "error": _callback_error(payload),
                "completed_at": _now_iso(),
            }
        ).eq("task_id", task_id).execute()
        log.info("kie_callback_failed", task_id=task_id)
        return {"ok": True, "deduped": False, "task_id": task_id, "status": "failed"}

    urls = _extract_result_urls(payload)
    stored = await _store_render_result(
        task_id=task_id, theme=task.get("theme"), urls=urls
    )
    _mark_completed(
        task_id, result_url=urls[0], clip_id=str(stored.get("clip_id") or "") or None
    )
    log.info(
        "kie_callback_recorded",
        task_id=task_id,
        creative_id=task.get("creative_id"),
        clip_id=stored.get("clip_id"),
    )
    return {
        "ok": True,
        "deduped": False,
        "task_id": task_id,
        "status": "completed",
        "clip_id": stored.get("clip_id"),
    }


def _callback_state(payload: dict[str, Any]) -> str:
    """Classify a callback body as ``failed`` or ``completed`` (default).

    kie signals a failure via a unified ``data.state == 'fail'`` or a Veo
    ``data.successFlag in (2, 3)``. Anything else (success / present URLs) is
    treated as a completion -- the URL extraction is the real gate.
    """
    data = payload.get("data") if isinstance(payload.get("data"), dict) else {}
    if data.get("state") == "fail":
        return "failed"
    if data.get("successFlag") in (2, 3):
        return "failed"
    return "completed"


def _callback_error(payload: dict[str, Any]) -> str:
    data = payload.get("data") if isinstance(payload.get("data"), dict) else {}
    return str(
        data.get("errorMessage")
        or data.get("failMsg")
        or data.get("failCode")
        or "kie reported a render failure"
    )


__all__ = ["router", "KieCallbackBody", "kie_video_callback", "RENDER_TASKS_TABLE"]
