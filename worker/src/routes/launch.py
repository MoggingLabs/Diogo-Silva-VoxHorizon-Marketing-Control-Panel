"""Launch validation routes.

Thin transport over :func:`scripts_runner.run_launch_package_validate`. The
upstream ``launch_package.py`` script is the authority on whether all the
pieces of a launch (Drive paths, paired copy, targeting, budget, ...) are
present and valid. We just shell out to it and pipe the verdict through.

Routes:
    POST /work/launch/validate
        body: { brief_id: str, format: "image"|"video", payload?: dict }

Errors:
    - 400 — payload validation
    - 404 — brief doesn't exist (Next.js side should not even ask, but defence)
    - 503 — upstream scripts repo missing
"""

from __future__ import annotations

from typing import Any, Literal

import structlog
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from ..auth import verify_secret
from ..services.scripts_runner import run_launch_package_validate


log = structlog.get_logger(__name__)


router = APIRouter()


class LaunchValidateInput(BaseModel):
    """POST body for ``/work/launch/validate``."""

    brief_id: str = Field(..., min_length=1)
    format: Literal["image", "video"]
    # Optional pre-fetched payload — saves an extra Supabase round-trip
    # from the upstream script. The Next.js side will typically pass the
    # full launch payload it has already assembled.
    payload: dict[str, Any] | None = None


class LaunchValidateResult(BaseModel):
    """Response shape for ``/work/launch/validate``."""

    ok: bool
    issues: list[str]
    raw_stdout: str = ""
    raw_stderr: str = ""


@router.post(
    "/work/launch/validate",
    dependencies=[Depends(verify_secret)],
    response_model=LaunchValidateResult,
)
async def validate_launch(body: LaunchValidateInput) -> LaunchValidateResult:
    """Validate a launch package via the upstream ``launch_package.py``.

    Returns ``{ ok, issues, raw_stdout, raw_stderr }`` so the Next.js side
    can show the operator a structured "what's missing" list when the
    validator complains.
    """
    try:
        result = await run_launch_package_validate(
            brief_id=body.brief_id,
            format=body.format,
            payload=body.payload,
        )
    except RuntimeError as e:
        # Upstream scripts repo not installed (CI / WSL / dev). Surface as
        # 503 so the operator UI can show "Validator unavailable" rather
        # than a 500.
        log.warning("launch_validate_unavailable", brief_id=body.brief_id, error=str(e))
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(e)) from e

    log.info(
        "launch_validate_done",
        brief_id=body.brief_id,
        format=body.format,
        ok=result.ok,
        issue_count=len(result.issues),
    )

    return LaunchValidateResult(
        ok=result.ok,
        issues=result.issues,
        raw_stdout=result.raw_stdout,
        raw_stderr=result.raw_stderr,
    )
