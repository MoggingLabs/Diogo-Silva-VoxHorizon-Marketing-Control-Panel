"""File ingest + Supabase Storage upload routes — real implementation lands in M3."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status

from ..auth import verify_secret


router = APIRouter()


@router.post("/work/upload", dependencies=[Depends(verify_secret)])
def upload_file() -> dict[str, str]:
    raise HTTPException(
        status_code=status.HTTP_501_NOT_IMPLEMENTED,
        detail="Not implemented; lands in M3.",
    )
