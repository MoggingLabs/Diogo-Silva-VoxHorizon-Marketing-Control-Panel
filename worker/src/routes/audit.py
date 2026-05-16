"""Audit runner routes — real implementation lands in M4."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status

from ..auth import verify_secret


router = APIRouter()


@router.post("/work/audit/run", dependencies=[Depends(verify_secret)])
def run_audit() -> dict[str, str]:
    raise HTTPException(
        status_code=status.HTTP_501_NOT_IMPLEMENTED,
        detail="Not implemented; lands in M4.",
    )
