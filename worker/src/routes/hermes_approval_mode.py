"""HTTP routes for the operator-controlled approval mode toggle.

Three thin endpoints on top of
:mod:`..services.hermes_approval_mode`:

  * ``GET  /work/hermes/approval-mode``        — read the singleton
  * ``PUT  /work/hermes/approval-mode``        — set the singleton + audit
  * ``GET  /work/hermes/approval-mode/audit``  — recent transitions

Auth: ``Authorization: Bearer <VOXHORIZON_APPROVAL_TOKEN>`` — same
narrowly-scoped token the long-poll routes use (re-shared so the
Hermes plugin only carries one secret). Comparison is constant-time via
:func:`hmac.compare_digest`.

Failure mapping:

  * 401 — missing / wrong / unset bearer
  * 422 — Pydantic / :class:`InvalidModeError` rejection
  * 502 — Supabase plumbing failure
  * 200 — happy path
"""

from __future__ import annotations

import hmac

import structlog
from fastapi import APIRouter, Header, HTTPException, Query, status
from pydantic import BaseModel, Field

from ..services import hermes_approval_mode as service


log = structlog.get_logger(__name__)


router = APIRouter(prefix="/work/hermes/approval-mode")


_BEARER_PREFIX = "Bearer "


def _verify_token(authorization: str | None) -> None:
    """Raise 401 unless ``authorization`` carries the configured token.

    Fail-closed: a missing env var rejects every request. Mirrors the
    pattern in :mod:`.hermes_approval` so the two routes have
    identical auth semantics.
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


class ApprovalModeResponse(BaseModel):
    """Response body for GET + PUT."""

    mode: str
    expires_at: str | None = None
    set_by: str | None = None
    set_at: str
    note: str | None = None


class ApprovalModeUpdateBody(BaseModel):
    """PUT body. Pydantic validates the shape; service-layer
    :func:`validate_mode_payload` checks the cross-field invariants.
    """

    mode: str = Field(..., min_length=1)
    ttl_seconds: int | None = Field(default=None)
    note: str | None = Field(default=None, max_length=2000)
    changed_by: str | None = Field(default=None, max_length=200)


class ApprovalModeAuditEntry(BaseModel):
    """One row in the audit list response."""

    id: str
    from_mode: str
    to_mode: str
    ttl_seconds: int | None = None
    changed_at: str
    changed_by: str
    note: str | None = None


class ApprovalModeAuditResponse(BaseModel):
    """Response body for the audit list."""

    entries: list[ApprovalModeAuditEntry]


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@router.get("", response_model=ApprovalModeResponse)
async def get_mode_route(
    authorization: str | None = Header(default=None),
) -> ApprovalModeResponse:
    """Read the current mode."""
    _verify_token(authorization)

    try:
        row = await service.get_mode()
    except service.ApprovalModeError as exc:
        log.warning("approval_mode_get_upstream_error", error=str(exc))
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=str(exc),
        ) from exc

    return ApprovalModeResponse(
        mode=row.mode,
        expires_at=row.expires_at,
        set_by=row.set_by,
        set_at=row.set_at,
        note=row.note,
    )


@router.put("", response_model=ApprovalModeResponse)
async def put_mode_route(
    body: ApprovalModeUpdateBody,
    authorization: str | None = Header(default=None),
) -> ApprovalModeResponse:
    """Set the mode + write an audit row.

    Returns:
        * ``200`` with the newly-written row.
        * ``401`` on missing / wrong bearer.
        * ``422`` on validation failure (unknown mode, missing TTL on
          AUTO_APPROVE, TTL on non-AUTO_APPROVE, TTL out of bounds).
        * ``502`` on a Supabase failure.
    """
    _verify_token(authorization)

    try:
        row = await service.set_mode(
            mode=body.mode,
            ttl_seconds=body.ttl_seconds,
            changed_by=body.changed_by or "dashboard",
            note=body.note,
        )
    except service.InvalidModeError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=str(exc),
        ) from exc
    except service.ApprovalModeError as exc:
        log.warning("approval_mode_put_upstream_error", error=str(exc))
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=str(exc),
        ) from exc

    log.info(
        "approval_mode_set_via_route",
        mode=row.mode,
        ttl_seconds=body.ttl_seconds,
        changed_by=body.changed_by or "dashboard",
    )
    return ApprovalModeResponse(
        mode=row.mode,
        expires_at=row.expires_at,
        set_by=row.set_by,
        set_at=row.set_at,
        note=row.note,
    )


@router.get("/audit", response_model=ApprovalModeAuditResponse)
async def get_audit_route(
    authorization: str | None = Header(default=None),
    limit: int = Query(
        default=service.DEFAULT_AUDIT_LIMIT,
        ge=1,
        le=service.MAX_AUDIT_LIMIT,
    ),
) -> ApprovalModeAuditResponse:
    """List recent mode transitions."""
    _verify_token(authorization)

    try:
        rows = await service.get_audit_rows(limit=limit)
    except service.ApprovalModeError as exc:
        log.warning(
            "approval_mode_audit_upstream_error", error=str(exc)
        )
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=str(exc),
        ) from exc

    return ApprovalModeAuditResponse(
        entries=[
            ApprovalModeAuditEntry(
                id=r.id,
                from_mode=r.from_mode,
                to_mode=r.to_mode,
                ttl_seconds=r.ttl_seconds,
                changed_at=r.changed_at,
                changed_by=r.changed_by,
                note=r.note,
            )
            for r in rows
        ]
    )


__all__ = ["router"]
