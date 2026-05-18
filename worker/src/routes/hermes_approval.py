"""HTTP routes for the Hermes plugin's dashboard-driven approval flow (HI-14).

The Hermes plugin (HI-13, written in Wave 20) AWAITS these endpoints. The
operator decision lands in Supabase via the dashboard's UPDATE on the
``approvals`` row; this router converts that into a synchronous HTTP
response for the plugin.

Routes
------
* ``POST /work/hermes/approval`` — long-poll for a decision. Returns
  ``{"decision": ..., "notes": ...}`` once the operator decides or
  ``rejected`` on timeout/cancel.
* ``GET /work/hermes/approval/{id}`` — read current state (health
  check + recovery after a blip).
* ``POST /work/hermes/approval/{id}/cancel`` — plugin-initiated
  cancellation, e.g. when the originating Hermes session ended.

Auth
----
A separate bearer token ``VOXHORIZON_APPROVAL_TOKEN`` (NOT the
dashboard's ``WORKER_SHARED_SECRET``, NOR the hook's
``DASHBOARD_WEBHOOK_TOKEN``). The plugin lives in Ekko's container, so
narrowly scoping its bearer means a compromise there can't pivot to
the rest of the worker. Comparison is constant-time via
:func:`hmac.compare_digest`.

Concurrency cap
---------------
The service module exposes :func:`acquire_slot`; the POST handler
calls it BEFORE entering the long poll and returns 503 when the cap
is full. GET and cancel are cheap reads/writes and don't consume a
slot.
"""

from __future__ import annotations

import hmac

import structlog
from fastapi import APIRouter, Header, HTTPException, status
from pydantic import BaseModel, Field

from ..services import hermes_approval as service


log = structlog.get_logger(__name__)


router = APIRouter(prefix="/work/hermes/approval")


_BEARER_PREFIX = "Bearer "


def _verify_token(authorization: str | None) -> None:
    """Raise 401 unless ``authorization`` carries the configured token.

    Fail-closed: a missing env var rejects every request.
    """
    expected = service.get_approval_token()
    if not expected:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Approval token not configured",
            headers={"WWW-Authenticate": "Bearer"},
        )
    if not authorization or not authorization.startswith(_BEARER_PREFIX):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing or malformed Authorization header",
            headers={"WWW-Authenticate": "Bearer"},
        )
    presented = authorization[len(_BEARER_PREFIX) :].strip()
    if not hmac.compare_digest(
        presented.encode("utf-8"), expected.encode("utf-8")
    ):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid approval token",
            headers={"WWW-Authenticate": "Bearer"},
        )


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------


class ApprovalRequestBody(BaseModel):
    """POST body for ``/work/hermes/approval``.

    Pydantic validates types/min lengths; FastAPI surfaces validation
    errors as 422 automatically.
    """

    approval_id: str = Field(..., min_length=1)
    ekko_session_id: str = Field(..., min_length=1)
    ekko_tool_call_id: str = Field(..., min_length=1)
    tool_name: str = Field(..., min_length=1)
    tool_args: dict
    risk_class: str | None = None
    context: dict | None = None
    timeout_s: int = Field(default=service.DEFAULT_TIMEOUT_S, gt=0)


class ApprovalDecisionResponse(BaseModel):
    """Response body for the long-poll route."""

    decision: str
    notes: str | None = None


class CancelResponse(BaseModel):
    """Response body for the cancel route."""

    cancelled: bool


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@router.post("", response_model=ApprovalDecisionResponse)
async def post_approval(
    body: ApprovalRequestBody,
    authorization: str | None = Header(default=None),
) -> ApprovalDecisionResponse:
    """Long-poll for the operator's decision on one tool call.

    Returns:
        * ``200`` with the decision once it lands.
        * ``401`` on missing / wrong bearer.
        * ``503`` when the concurrency cap is hit (plugin should retry
          with exponential backoff).
        * ``502`` if Supabase plumbing failed and we can't claim a
          definitive answer either way.
    """
    _verify_token(authorization)

    guard = await service.acquire_slot()
    if guard is None:
        log.warning(
            "hermes_approval_at_capacity",
            approval_id=body.approval_id,
        )
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Approval queue at capacity; retry shortly",
        )

    async with guard:
        try:
            decision = await service.request_approval(
                approval_id=body.approval_id,
                ekko_session_id=body.ekko_session_id,
                ekko_tool_call_id=body.ekko_tool_call_id,
                tool_name=body.tool_name,
                tool_args=body.tool_args,
                risk_class=body.risk_class,
                context=body.context,
                timeout_s=body.timeout_s,
            )
        except service.ApprovalError as exc:
            log.warning(
                "hermes_approval_upstream_error",
                approval_id=body.approval_id,
                error=str(exc),
            )
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail=str(exc),
            ) from exc

    log.info(
        "hermes_approval_decided",
        approval_id=body.approval_id,
        decision=decision.decision,
    )
    return ApprovalDecisionResponse(
        decision=decision.decision, notes=decision.notes
    )


@router.get("/{approval_id}")
async def get_approval_state(
    approval_id: str,
    authorization: str | None = Header(default=None),
) -> dict:
    """Read one ``approvals`` row.

    Returns:
        * ``200`` with the full row dict when the id exists.
        * ``401`` on missing / wrong bearer.
        * ``404`` when no row matches the id.
        * ``502`` on a Supabase failure.
    """
    _verify_token(authorization)

    try:
        row = await service.get_approval(approval_id)
    except service.ApprovalError as exc:
        log.warning(
            "hermes_approval_get_upstream_error",
            approval_id=approval_id,
            error=str(exc),
        )
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=str(exc),
        ) from exc

    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Approval not found",
        )
    return row


@router.post(
    "/{approval_id}/cancel",
    response_model=CancelResponse,
)
async def cancel_approval_route(
    approval_id: str,
    authorization: str | None = Header(default=None),
) -> CancelResponse:
    """Flip a pending approval to ``cancelled``.

    Idempotent: cancelling an already-decided / already-cancelled row
    returns ``{"cancelled": false}`` rather than 4xx so the plugin can
    blindly fire cancels on session-end without thinking about state.
    """
    _verify_token(authorization)

    try:
        ok = await service.cancel_approval(approval_id)
    except service.ApprovalError as exc:
        log.warning(
            "hermes_approval_cancel_upstream_error",
            approval_id=approval_id,
            error=str(exc),
        )
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=str(exc),
        ) from exc

    log.info(
        "hermes_approval_cancel",
        approval_id=approval_id,
        cancelled=ok,
    )
    return CancelResponse(cancelled=ok)


__all__ = ["router"]
