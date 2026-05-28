"""Work-item queue REST surface (silent-failure PR-1).

Thin wrappers around :mod:`services.work_queue` so consumers (the operator
daemon, the deterministic worker producers, the dashboard's
``enqueueWorkItem`` helper) can drive the queue over HTTP with the same
bearer auth every other worker route uses.

Routes follow the table in the plan-of-record:

  POST  /work/queue/claim                   {kind, consumer_id}
  PATCH /work/queue/{id}/heartbeat          {claim_token}
  PATCH /work/queue/{id}/complete           {claim_token, result}
  PATCH /work/queue/{id}/fail               {claim_token, error_kind,
                                             error_detail?, retryable?}
  PATCH /work/queue/{id}/cancel             {claim_token?, reason}
  POST  /work/queue/consumers               {id, kind, startup_check?, ...}
  PATCH /work/queue/consumers/{id}          {status?, last_seen_at?, ...}

The token-rotation contract:
  * :func:`heartbeat`, :func:`complete`, :func:`fail` are TOKEN-SCOPED; a
    presented token the watchdog already rotated returns ``409 token_rotated``
    so the consumer aborts cleanly without retrying blind.
  * :func:`cancel` accepts an optional token: when present it is token-scoped
    (the consumer's clean-shutdown path), when absent it force-cancels (an
    admin path, mirrored by ``pipeline_cancel_propagate_to_work_items``).

Routes do NOT call ``pipeline_events.insert`` -- the
``work_item_emit_pipeline_event`` trigger does that for us on every status
change. This is the structural anti-drift fix the redesign hinges on.
"""

from __future__ import annotations

from typing import Any, Literal

import structlog
from fastapi import APIRouter, Depends, HTTPException, Path, Response, status
from pydantic import BaseModel, Field

from ..auth import verify_secret
from ..services import work_queue
from ..supabase_client import get_supabase_admin


log = structlog.get_logger(__name__)

router = APIRouter()


# ----------------------------------------------------------------------------
# Pydantic bodies
# ----------------------------------------------------------------------------


# The set of valid kinds mirrors the ``work_item_kind`` enum in migration 0050.
# Kept here so a bad body 422s at the API boundary (the DB enum is also a
# defence-in-depth, but the API rejection is cheaper + greppable).
WorkItemKind = Literal[
    "operator_dispatch",
    "outbox_meta_record_launch",
    "outbox_drive_finalize_verified",
    "outbox_ghl_send",
    "kie_video_render",
    "kie_image_render",
    "kie_tts",
    "ffmpeg_compose",
    "worker_ideation",
    "worker_generation",
    "worker_monitor",
    # FIX-A: deterministic-mode post-generation consumers (migration 0053).
    "worker_qa",
    "worker_compliance",
    "worker_spec",
    "broll_search",
    "other",
]

ConsumerStatus = Literal["starting", "live", "degraded", "stopped", "down"]


class ClaimBody(BaseModel):
    """POST body for ``/work/queue/claim``."""

    kind: WorkItemKind
    consumer_id: str = Field(..., min_length=1, max_length=128)


class HeartbeatBody(BaseModel):
    """PATCH body for ``/work/queue/{id}/heartbeat``."""

    claim_token: str = Field(..., min_length=1)


class CompleteBody(BaseModel):
    """PATCH body for ``/work/queue/{id}/complete``."""

    claim_token: str = Field(..., min_length=1)
    result: dict[str, Any] | None = None


class FailBody(BaseModel):
    """PATCH body for ``/work/queue/{id}/fail``.

    ``error_kind`` is REQUIRED -- the ``work_item_failure_explained`` CHECK in
    migration 0050 rejects a failure that doesn't name itself, so the API
    enforces the same thing one layer up for a clean 422 instead of a 500.
    """

    claim_token: str = Field(..., min_length=1)
    error_kind: str = Field(..., min_length=1, max_length=128)
    error_detail: dict[str, Any] | None = None
    retryable: bool = True
    backoff_seconds: int = Field(default=60, ge=0, le=86_400)


class CancelBody(BaseModel):
    """PATCH body for ``/work/queue/{id}/cancel``.

    ``claim_token`` is OPTIONAL: a consumer cancelling cleanly (on SIGTERM)
    presents its token (token-scoped) so the cancel races safely against a
    watchdog rotation; an admin path omits it (force-cancel).
    """

    claim_token: str | None = None
    reason: str = Field(default="user_cancelled", min_length=1, max_length=128)


class ConsumerCreateBody(BaseModel):
    """POST body for ``/work/queue/consumers``."""

    id: str = Field(..., min_length=1, max_length=128)
    kind: WorkItemKind
    status: ConsumerStatus = "starting"
    startup_check: dict[str, Any] | None = None
    image_tag: str | None = None
    hostname: str | None = None


class ConsumerUpdateBody(BaseModel):
    """PATCH body for ``/work/queue/consumers/{id}``."""

    status: ConsumerStatus | None = None
    startup_check: dict[str, Any] | None = None
    image_tag: str | None = None
    hostname: str | None = None


# ----------------------------------------------------------------------------
# Routes
# ----------------------------------------------------------------------------


@router.post(
    "/work/queue/claim",
    dependencies=[Depends(verify_secret)],
    response_model=None,
)
def claim(body: ClaimBody):
    """Claim the next due ``work_item`` of ``kind`` for ``consumer_id``.

    Returns the row (200) or a 204 No Content when nothing is due. Wrapping
    the RPC means consumers never need to know the SQL surface.

    ``response_model=None`` is necessary because FastAPI's response-model
    generator can't synthesize a schema for ``dict | Response``; the route
    explicitly returns one or the other.
    """
    sb = get_supabase_admin()
    row = work_queue.claim_work_item(sb, kind=body.kind, consumer=body.consumer_id)
    if row is None:
        return Response(status_code=status.HTTP_204_NO_CONTENT)
    log.info(
        "work_item_claimed",
        work_item_id=row.get("id"),
        kind=body.kind,
        consumer_id=body.consumer_id,
    )
    return row


@router.patch(
    "/work/queue/{work_item_id}/heartbeat",
    dependencies=[Depends(verify_secret)],
    status_code=status.HTTP_204_NO_CONTENT,
)
def heartbeat(
    body: HeartbeatBody,
    work_item_id: str = Path(..., min_length=1),
) -> Response:
    """Refresh a held row's heartbeat (claimed -> running on first call).

    Returns 204 on success, 409 when the presented ``claim_token`` was already
    rotated by the watchdog (the consumer aborts cleanly).
    """
    sb = get_supabase_admin()
    ok = work_queue.heartbeat_work_item(
        sb, work_item_id=work_item_id, claim_token=body.claim_token
    )
    if not ok:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="claim_token rotated; abort and re-claim",
        )
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.patch(
    "/work/queue/{work_item_id}/complete",
    dependencies=[Depends(verify_secret)],
    status_code=status.HTTP_204_NO_CONTENT,
)
def complete(
    body: CompleteBody,
    work_item_id: str = Path(..., min_length=1),
) -> Response:
    """Close a held row as completed; the trigger emits ``*_completed``."""
    sb = get_supabase_admin()
    ok = work_queue.complete_work_item(
        sb,
        work_item_id=work_item_id,
        claim_token=body.claim_token,
        result=body.result,
    )
    if not ok:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="claim_token rotated; abort and re-claim",
        )
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.patch(
    "/work/queue/{work_item_id}/fail",
    dependencies=[Depends(verify_secret)],
    status_code=status.HTTP_204_NO_CONTENT,
)
def fail(
    body: FailBody,
    work_item_id: str = Path(..., min_length=1),
) -> Response:
    """Close a held row as failed; names the failure for the dashboard."""
    sb = get_supabase_admin()
    ok = work_queue.fail_work_item(
        sb,
        work_item_id=work_item_id,
        claim_token=body.claim_token,
        error_kind=body.error_kind,
        error_detail=body.error_detail,
        retryable=body.retryable,
        backoff_seconds=body.backoff_seconds,
    )
    if not ok:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="claim_token rotated; abort and re-claim",
        )
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.patch(
    "/work/queue/{work_item_id}/cancel",
    dependencies=[Depends(verify_secret)],
    status_code=status.HTTP_204_NO_CONTENT,
)
def cancel(
    body: CancelBody,
    work_item_id: str = Path(..., min_length=1),
) -> Response:
    """Cancel a row; token-scoped when ``claim_token`` is provided.

    Mirrors the two-caller contract documented on
    :func:`services.work_queue.cancel_work_item`: a consumer SIGTERM presents
    its token (token-scoped, races safely vs. the watchdog); an admin path
    omits it (force-cancel).
    """
    sb = get_supabase_admin()
    ok = work_queue.cancel_work_item(
        sb,
        work_item_id=work_item_id,
        reason=body.reason,
        claim_token=body.claim_token,
    )
    if not ok and body.claim_token is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="claim_token rotated; abort and re-claim",
        )
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post(
    "/work/queue/consumers",
    dependencies=[Depends(verify_secret)],
    status_code=status.HTTP_201_CREATED,
)
def upsert_consumer(body: ConsumerCreateBody) -> dict[str, Any]:
    """Register a consumer (the daemon's startup write)."""
    sb = get_supabase_admin()
    row = work_queue.upsert_consumer(
        sb,
        consumer_id=body.id,
        kind=body.kind,
        status=body.status,
        startup_check=body.startup_check,
        image_tag=body.image_tag,
        hostname=body.hostname,
    )
    return row


@router.patch(
    "/work/queue/consumers/{consumer_id}",
    dependencies=[Depends(verify_secret)],
    status_code=status.HTTP_204_NO_CONTENT,
)
def update_consumer(
    body: ConsumerUpdateBody,
    consumer_id: str = Path(..., min_length=1),
) -> Response:
    """Patch a consumer row (status flip + heartbeat in one call).

    A daemon calls this every ``consumer_heartbeat_s`` to bump
    ``last_seen_at``; status flips (``starting -> live``,
    ``live -> stopped`` on SIGTERM) ride the same surface.
    """
    if body.status is None and body.startup_check is None \
            and body.image_tag is None and body.hostname is None:
        # A heartbeat-only call: bump last_seen_at without touching anything else.
        sb = get_supabase_admin()
        work_queue.heartbeat_consumer(sb, consumer_id=consumer_id)
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    sb = get_supabase_admin()
    patch: dict[str, Any] = {"last_seen_at": work_queue._now_iso()}
    if body.status is not None:
        patch["status"] = body.status
    if body.startup_check is not None:
        patch["startup_check"] = body.startup_check
    if body.image_tag is not None:
        patch["image_tag"] = body.image_tag
    if body.hostname is not None:
        patch["hostname"] = body.hostname
    sb.table("work_item_consumers").update(patch).eq("id", consumer_id).execute()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


__all__ = ["router"]
