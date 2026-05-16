"""Claude Code chat / agent loop routes — real implementation lands in M2."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status

from ..auth import verify_secret


router = APIRouter()


@router.post("/work/chat", dependencies=[Depends(verify_secret)])
def chat() -> dict[str, str]:
    raise HTTPException(
        status_code=status.HTTP_501_NOT_IMPLEMENTED,
        detail="Not implemented; lands in M2.",
    )
