"""File ingest + Drive upload routes.

Wave 4: ``/work/upload/drive`` (image) and ``/work/video/upload-drive`` (video)
download a finished creative from Supabase Storage, name it per the launch
naming convention, route it into the correct folder of the marketing-dept
Drive tree, and persist the resulting Drive URL back onto the creative row.

The legacy ``/work/upload`` endpoint stays as a 501 — the upload flow now
goes through one of the two format-specific routes.
"""

from __future__ import annotations

import tempfile
from pathlib import Path
from typing import Literal

import structlog
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from ..auth import verify_secret
from ..services.drive import (
    build_image_filename,
    build_video_filename,
    route_folder,
    route_subpath,
    upload_to_drive,
)
from ..services.storage import BUCKET
from ..supabase_client import get_supabase_admin


log = structlog.get_logger(__name__)


router = APIRouter()


# ---------------------------------------------------------------------------
# Legacy stub — keep for backward-compat with anything still hitting it.
# ---------------------------------------------------------------------------


@router.post("/work/upload", dependencies=[Depends(verify_secret)])
def upload_file() -> dict[str, str]:
    raise HTTPException(
        status_code=status.HTTP_501_NOT_IMPLEMENTED,
        detail="Use /work/upload/drive (image) or /work/video/upload-drive (video).",
    )


# ---------------------------------------------------------------------------
# Image
# ---------------------------------------------------------------------------


class ImageDriveUploadInput(BaseModel):
    """POST body for ``/work/upload/drive``."""

    creative_id: str = Field(..., min_length=1)


class DriveUploadResult(BaseModel):
    """Common response shape for both image and video upload routes."""

    creative_id: str
    drive_url: str
    filename: str
    folder_id: str
    subpath: str


def _download_creative_bytes(*, path: str, bucket: str = BUCKET) -> bytes:
    """Pull the creative's bytes out of Supabase Storage.

    Extracted so tests can monkey-patch a stub. The supabase-py SDK is
    synchronous; we ``await`` callers anyway for FastAPI ergonomics.
    """
    sb = get_supabase_admin()
    resp = sb.storage.from_(bucket).download(path)
    # supabase-py returns either bytes (≥2.0) or a Response-shaped object —
    # normalize to bytes here so callers don't have to.
    if isinstance(resp, (bytes, bytearray)):
        return bytes(resp)
    raw = getattr(resp, "content", None)
    if isinstance(raw, (bytes, bytearray)):
        return bytes(raw)
    raise RuntimeError(f"unexpected Storage download response: {type(resp).__name__}")


def _coerce_branded(payload: dict | None) -> bool:
    """Read ``branded`` off the brief payload, defaulting to True.

    Brief payloads can omit the flag (older rows); branded routing is the
    default for roofing clients (most of the v1 traffic), so we default to
    True. The Next.js side enforces the boolean explicitly going forward.
    """
    if not isinstance(payload, dict):
        return True
    val = payload.get("branded")
    if val is None:
        return True
    return bool(val)


def _coerce_state(payload: dict | None) -> str | None:
    """Extract a US state code from the brief payload, if present.

    Looks at the targeting block (``state`` / ``market`` fallback). Returns
    ``None`` rather than guessing — the gog CLI handles missing sub-paths
    by dropping into the parent folder, which is the right thing for ads
    without geographic targeting.
    """
    if not isinstance(payload, dict):
        return None
    targeting = payload.get("targeting") or {}
    if isinstance(targeting, dict):
        state = targeting.get("state")
        if isinstance(state, str) and state.strip():
            return state.strip()
    market = payload.get("market")
    if isinstance(market, str) and "," in market:
        # "Austin, TX" → "TX"
        tail = market.rsplit(",", 1)[1].strip()
        if 2 <= len(tail) <= 3:
            return tail.upper()
    return None


@router.post(
    "/work/upload/drive",
    dependencies=[Depends(verify_secret)],
    response_model=DriveUploadResult,
)
async def upload_image_to_drive(body: ImageDriveUploadInput) -> DriveUploadResult:
    """Download an approved image creative + upload it to Drive.

    Looks up the creative row, fetches its bytes from Supabase Storage,
    builds the launch-ready filename from the naming convention, routes
    it to the correct sub-path within ``3 Image Ads``, and writes the
    resulting Drive URL back onto ``creatives.file_path_drive``.
    """
    sb = get_supabase_admin()

    creative_resp = (
        sb.table("creatives")
        .select(
            "id, concept, ratio, version, file_path_supabase, brief_id, "
            "briefs(id, payload, clients(slug, name, service_type))"
        )
        .eq("id", body.creative_id)
        .maybe_single()
        .execute()
    )
    row = creative_resp.data
    if not row:
        raise HTTPException(status_code=404, detail="creative not found")
    if not row.get("file_path_supabase"):
        raise HTTPException(status_code=409, detail="creative has no file_path_supabase yet")

    brief = (row.get("briefs") or {}) if isinstance(row.get("briefs"), dict) else {}
    client = brief.get("clients") or {}
    if not isinstance(client, dict):
        client = {}

    service_type = client.get("service_type") or "roofing"
    if service_type not in {"roofing", "remodeling"}:
        raise HTTPException(status_code=409, detail=f"unsupported service_type: {service_type}")

    branded = _coerce_branded(brief.get("payload") if isinstance(brief, dict) else None)
    state = _coerce_state(brief.get("payload") if isinstance(brief, dict) else None)
    client_slug = client.get("slug") if isinstance(client.get("slug"), str) else None
    client_name = client.get("name") or client_slug or "VoxHorizon"

    ratio = row.get("ratio") or "1x1"
    version = row.get("version") or "v1.0"
    concept = row.get("concept") or "creative"

    filename = build_image_filename(
        client_label=client_name,
        concept=concept,
        ratio=ratio,
        version=version,
    )
    parent_folder_id = route_folder(service_type=service_type, branded=branded, fmt="image")
    subpath = route_subpath(
        service_type=service_type,
        branded=branded,
        state=state,
        client_slug=client_slug,
    )

    bytes_ = _download_creative_bytes(path=row["file_path_supabase"])

    with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as fh:
        tmp_path = Path(fh.name)
        fh.write(bytes_)

    try:
        try:
            drive_url = await upload_to_drive(
                tmp_path,
                filename=filename,
                parent_folder_id=parent_folder_id,
                subpath=subpath,
            )
        except RuntimeError as e:
            # `gog` is missing or returned non-zero. 503 — service unavailable.
            log.warning("drive_upload_failed", creative_id=body.creative_id, error=str(e))
            raise HTTPException(status_code=503, detail=str(e)) from e
    finally:
        try:
            tmp_path.unlink()
        except FileNotFoundError:
            pass

    # Persist the Drive URL back onto the creative row.
    sb.table("creatives").update({"file_path_drive": drive_url}).eq("id", body.creative_id).execute()
    sb.table("events").insert(
        {
            "kind": "creative_drive_uploaded",
            "ref_table": "creatives",
            "ref_id": body.creative_id,
            "payload": {"drive_url": drive_url, "filename": filename, "folder_id": parent_folder_id},
        }
    ).execute()

    log.info(
        "drive_upload_ok",
        creative_id=body.creative_id,
        drive_url=drive_url,
        folder_id=parent_folder_id,
        subpath=subpath,
    )

    return DriveUploadResult(
        creative_id=body.creative_id,
        drive_url=drive_url,
        filename=filename,
        folder_id=parent_folder_id,
        subpath=subpath,
    )


# ---------------------------------------------------------------------------
# Video
# ---------------------------------------------------------------------------


class VideoDriveUploadInput(BaseModel):
    """POST body for ``/work/video/upload-drive``."""

    video_creative_id: str = Field(..., min_length=1)
    # Which captured/composed file to upload. Defaults to the final
    # captioned cut; callers can pin ``composed`` if they want the
    # pre-caption version for review-only purposes.
    source: Literal["captioned", "composed"] = "captioned"


@router.post(
    "/work/video/upload-drive",
    dependencies=[Depends(verify_secret)],
    response_model=DriveUploadResult,
)
async def upload_video_to_drive(body: VideoDriveUploadInput) -> DriveUploadResult:
    """Download a finished video creative + upload it to ``4.2 Video Output``.

    Mirrors :func:`upload_image_to_drive` for the video side. ``source``
    picks which file in storage to upload — defaults to ``captioned`` (the
    final cut shown to ad platforms).
    """
    sb = get_supabase_admin()

    creative_resp = (
        sb.table("video_creatives")
        .select(
            "id, version, captioned_path, composed_path, duration_actual_s, brief_id, "
            "video_briefs(id, payload, target_duration_s, clients(slug, name, service_type))"
        )
        .eq("id", body.video_creative_id)
        .maybe_single()
        .execute()
    )
    row = creative_resp.data
    if not row:
        raise HTTPException(status_code=404, detail="video creative not found")

    source_path = row.get(f"{body.source}_path")
    if not source_path:
        raise HTTPException(
            status_code=409,
            detail=f"video creative has no {body.source}_path yet",
        )

    brief = (row.get("video_briefs") or {}) if isinstance(row.get("video_briefs"), dict) else {}
    client = brief.get("clients") or {}
    if not isinstance(client, dict):
        client = {}

    service_type = client.get("service_type") or "roofing"
    if service_type not in {"roofing", "remodeling"}:
        raise HTTPException(status_code=409, detail=f"unsupported service_type: {service_type}")

    branded = _coerce_branded(brief.get("payload") if isinstance(brief, dict) else None)
    state = _coerce_state(brief.get("payload") if isinstance(brief, dict) else None)
    client_slug = client.get("slug") if isinstance(client.get("slug"), str) else None
    client_name = client.get("name") or client_slug or "VoxHorizon"

    # Video filenames carry the actual duration when known, falling back
    # to the target duration from the brief if the worker hasn't measured
    # the rendered file yet (e.g. unit-testable path).
    duration_s = row.get("duration_actual_s") or (brief.get("target_duration_s") if isinstance(brief, dict) else None)
    if not isinstance(duration_s, int) or duration_s <= 0:
        duration_s = 30
    version = f"v{row.get('version') or 1}.0"
    concept = (brief.get("payload") or {}).get("concept") if isinstance(brief, dict) else None
    if not isinstance(concept, str) or not concept.strip():
        concept = "video creative"

    filename = build_video_filename(
        client_label=client_name,
        concept=concept,
        duration_s=duration_s,
        version=version,
    )
    parent_folder_id = route_folder(service_type=service_type, branded=branded, fmt="video")
    subpath = route_subpath(
        service_type=service_type,
        branded=branded,
        state=state,
        client_slug=client_slug,
    )

    bytes_ = _download_creative_bytes(path=source_path)

    with tempfile.NamedTemporaryFile(suffix=".mp4", delete=False) as fh:
        tmp_path = Path(fh.name)
        fh.write(bytes_)

    try:
        try:
            drive_url = await upload_to_drive(
                tmp_path,
                filename=filename,
                parent_folder_id=parent_folder_id,
                subpath=subpath,
            )
        except RuntimeError as e:
            log.warning("video_drive_upload_failed", video_creative_id=body.video_creative_id, error=str(e))
            raise HTTPException(status_code=503, detail=str(e)) from e
    finally:
        try:
            tmp_path.unlink()
        except FileNotFoundError:
            pass

    sb.table("video_creatives").update({"drive_url": drive_url}).eq(
        "id", body.video_creative_id
    ).execute()
    sb.table("events").insert(
        {
            "kind": "video_creative_drive_uploaded",
            "ref_table": "video_creatives",
            "ref_id": body.video_creative_id,
            "payload": {"drive_url": drive_url, "filename": filename, "folder_id": parent_folder_id},
        }
    ).execute()

    log.info(
        "video_drive_upload_ok",
        video_creative_id=body.video_creative_id,
        drive_url=drive_url,
        folder_id=parent_folder_id,
        subpath=subpath,
    )

    return DriveUploadResult(
        creative_id=body.video_creative_id,
        drive_url=drive_url,
        filename=filename,
        folder_id=parent_folder_id,
        subpath=subpath,
    )
