"""GET /work/broll/{hash} — streams a b-roll clip after verifying a signed URL.

Deliberately does NOT use `verify_secret`: this endpoint authenticates
via the HMAC `sig` query param so the Vercel app can hand a plain URL to
the browser. The HMAC key is `WORKER_SHARED_SECRET`, so a leaked bearer
token leaks signed URLs and vice-versa — that's the intended blast radius.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import FileResponse

from ..config import Settings, get_settings
from ..services.broll_store import (
    LocalBrollStore,
    get_broll_store,
    verify_clip_signature,
)


router = APIRouter()


@router.get("/work/broll/{clip_id}")
def stream_broll(
    clip_id: str,
    exp: int,
    sig: str,
    settings: Settings = Depends(get_settings),
) -> FileResponse:
    if not verify_clip_signature(clip_id, exp, sig, settings.worker_shared_secret):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Invalid or expired signature",
        )

    store = get_broll_store()
    if not isinstance(store, LocalBrollStore):
        # The supabase backend serves its own signed URLs directly from
        # Supabase Storage; the worker never proxies those bytes.
        raise HTTPException(
            status_code=status.HTTP_501_NOT_IMPLEMENTED,
            detail="Supabase b-roll backend serves URLs directly; this route is local-only.",
        )

    clip_path = store.clip_path(clip_id)
    if not clip_path.exists():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Unknown clip_id: {clip_id}",
        )

    return FileResponse(
        path=clip_path,
        media_type="video/mp4",
        filename=f"{clip_id}.mp4",
    )
