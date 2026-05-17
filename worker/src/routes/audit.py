"""Audit runner routes — Meta + GHL → join → verdict → persist → notify.

Two endpoints, one per format:

* ``POST /work/audit/run`` — image pull (M4-1). Hits Meta with the base field
  set and writes to ``campaign_perf_image``.
* ``POST /work/audit/video`` — video pull (M4-13). Adds the four
  engagement-specific fields and writes to ``campaign_perf_video``.

Both expect the same body shape, mounted with the shared-secret auth gate.
The orchestrator returns an :class:`AuditReport` summarizing what it did;
we surface that as JSON so the Next.js side can render a "last run" panel
later.
"""

from __future__ import annotations

from typing import Literal

import structlog
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from ..auth import verify_secret
from ..services.audit_pull import AuditReport, run_audit


log = structlog.get_logger(__name__)


router = APIRouter()


# ---------------------------------------------------------------------------
# Schema
# ---------------------------------------------------------------------------


class AuditRunInput(BaseModel):
    """POST body for both audit endpoints."""

    window_days: Literal[1, 7, 30] = Field(default=30)
    client_id: str | None = Field(default=None, min_length=1)


class AuditRunResult(BaseModel):
    """Response shape for both audit endpoints."""

    format: Literal["image", "video"]
    window_days: int
    clients_processed: int
    rows_processed: int
    rows_upserted: int
    kills: int
    notifications_emitted: int
    errors: list[str] = []


# ---------------------------------------------------------------------------
# Handlers
# ---------------------------------------------------------------------------


def _to_response(report: AuditReport) -> AuditRunResult:
    return AuditRunResult(
        format=report.format,
        window_days=report.window_days,
        clients_processed=report.clients_processed,
        rows_processed=report.rows_processed,
        rows_upserted=report.rows_upserted,
        kills=report.kills,
        notifications_emitted=report.notifications_emitted,
        errors=list(report.errors),
    )


@router.post(
    "/work/audit/run",
    dependencies=[Depends(verify_secret)],
    response_model=AuditRunResult,
)
async def run_image_audit(body: AuditRunInput) -> AuditRunResult:
    """Run the image-creative audit pull (M4-1).

    Returns an :class:`AuditRunResult` describing what got pulled, persisted,
    and how many kill notifications fanned out. A 503 is surfaced if the
    upstream Meta / GHL keys aren't configured.
    """
    try:
        report = await run_audit(
            format="image",
            client_id=body.client_id,
            window_days=body.window_days,
        )
    except RuntimeError as e:
        # The Meta / GHL clients raise RuntimeError on missing env vars. We
        # surface those as 503 so the operator UI can render a "configure
        # tokens" hint rather than a generic 500.
        log.warning("audit_image_unavailable", error=str(e))
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(e)
        ) from e
    log.info(
        "audit_image_done",
        clients=report.clients_processed,
        rows=report.rows_processed,
        kills=report.kills,
    )
    return _to_response(report)


@router.post(
    "/work/audit/video",
    dependencies=[Depends(verify_secret)],
    response_model=AuditRunResult,
)
async def run_video_audit(body: AuditRunInput) -> AuditRunResult:
    """Run the video-creative audit pull (M4-13).

    Same shape as ``/work/audit/run`` but requests Meta's video-specific
    field set and writes to ``campaign_perf_video``. The video-only verdict
    rules (hook rate, drop-off, watch time) are applied in addition to the
    shared image-side rules.
    """
    try:
        report = await run_audit(
            format="video",
            client_id=body.client_id,
            window_days=body.window_days,
        )
    except RuntimeError as e:
        log.warning("audit_video_unavailable", error=str(e))
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(e)
        ) from e
    log.info(
        "audit_video_done",
        clients=report.clients_processed,
        rows=report.rows_processed,
        kills=report.kills,
    )
    return _to_response(report)
