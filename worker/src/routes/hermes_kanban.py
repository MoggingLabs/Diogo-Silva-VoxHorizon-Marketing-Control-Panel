"""Hermes kanban worker routes (HI-3 / Wave 18).

Five bearer-authed endpoints sit on top of
:class:`worker.src.services.hermes_kanban.HermesKanbanService`:

* ``POST /work/hermes/kanban``                   — create a task
* ``GET  /work/hermes/kanban/{task_id}``         — show a task
* ``POST /work/hermes/kanban/{task_id}/cancel``  — block (operator cancel)
* ``POST /work/hermes/kanban/{task_id}/retry``   — reclaim + unblock
* ``GET  /work/hermes/kanban/{task_id}/events``  — SSE event stream

Service injection: a module-level singleton lazily constructs the
service on first call. The :class:`HermesBridge` (Agent A's HI-1)
provides the container handle; the kanban service wraps it with the
parse / mirror logic. Tests swap the singleton via :func:`set_service`
(pattern mirrors the runner singleton on chat_stream).

Routes intentionally stay thin — the service owns parsing, Supabase
mirroring, and CLI invocation. The router is mostly Pydantic →
service-call → JSONResponse, with the tail endpoint wrapping the
service's async iterator in SSE framing.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator
from typing import Any

import structlog
from fastapi import APIRouter, Depends, HTTPException, Path
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

from ..auth import verify_secret
from ..services.hermes_kanban import (
    DEFAULT_ASSIGNEE,
    DEFAULT_BOARD,
    HermesKanbanError,
    HermesKanbanService,
)


log = structlog.get_logger(__name__)


router = APIRouter()


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------


class KanbanCreateInput(BaseModel):
    """POST body for ``/work/hermes/kanban`` — create a task."""

    title: str = Field(..., min_length=1, max_length=512)
    assignee: str = Field(default=DEFAULT_ASSIGNEE, min_length=1)
    context: dict[str, Any] = Field(default_factory=dict)
    parent_id: str | None = None
    board: str | None = None


class KanbanCreateResponse(BaseModel):
    """Response body for create — surfaces the new task id."""

    task_id: str
    assignee: str
    board: str


class KanbanActionResponse(BaseModel):
    """Generic ack for cancel / retry."""

    task_id: str
    action: str
    ok: bool = True


# ---------------------------------------------------------------------------
# Service singleton
# ---------------------------------------------------------------------------


_service: HermesKanbanService | None = None


def _get_service() -> HermesKanbanService:
    """Return the cached HermesKanbanService, building it lazily.

    Lazy so the import doesn't pull docker SDK + container resolution
    at app startup (the bridge constructor reaches out to the docker
    daemon, which is expensive and not always available — e.g. in CI
    without docker socket access).
    """
    global _service
    if _service is None:
        # Lazy import keeps the docker SDK out of the import graph at
        # app-start time. Tests that inject a fake via set_service()
        # bypass this branch entirely.
        from ..services.hermes_bridge import HermesBridge  # noqa: PLC0415

        bridge = HermesBridge()
        _service = HermesKanbanService(bridge)
    return _service


def set_service(service: HermesKanbanService | None) -> None:
    """Test helper — replace (or clear) the cached service.

    Passing ``None`` drops the singleton so the next call rebuilds it
    via :func:`_get_service`. Passing a fake lets tests run without
    spinning up docker.
    """
    global _service
    _service = service


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _service_error_to_http(exc: HermesKanbanError) -> HTTPException:
    """Translate a HermesKanbanError into a structured 502.

    We pick 502 over 500 because the failure originates upstream (the
    Hermes container), not in the worker's own code path. The detail
    body keeps stdout/stderr small so the dashboard can render it
    inline without bloating the wire.
    """
    detail = {
        "message": str(exc),
        "exit_code": exc.exit_code,
        "stdout": (exc.stdout or "")[:1000],
        "stderr": (exc.stderr or "")[:1000],
    }
    return HTTPException(status_code=502, detail=detail)


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@router.post(
    "/work/hermes/kanban",
    dependencies=[Depends(verify_secret)],
    response_model=KanbanCreateResponse,
)
async def create_kanban_task(body: KanbanCreateInput) -> KanbanCreateResponse:
    """Create a new Hermes kanban task.

    The route delegates everything to the service. The service mirrors
    the new row into Supabase before returning; the response surfaces
    the task id so the caller can immediately wire up an SSE event tail.
    """
    service = _get_service()
    try:
        task_id = await service.create_task(
            title=body.title,
            assignee=body.assignee,
            context=body.context,
            parent_id=body.parent_id,
            board=body.board,
        )
    except HermesKanbanError as exc:
        log.warning(
            "hermes_kanban_create_failed",
            title=body.title,
            assignee=body.assignee,
            error=str(exc),
            exit_code=exc.exit_code,
        )
        raise _service_error_to_http(exc) from exc

    return KanbanCreateResponse(
        task_id=task_id,
        assignee=body.assignee,
        board=body.board or DEFAULT_BOARD,
    )


@router.get(
    "/work/hermes/kanban/{task_id}",
    dependencies=[Depends(verify_secret)],
)
async def show_kanban_task(
    task_id: str = Path(..., min_length=1, max_length=128),
) -> JSONResponse:
    """Return the full state for a single kanban task.

    The payload is the service's HermesTask serialised as JSON — id,
    status, assignee, title, board, context, result, comments, events,
    parent_id. The dashboard renders this verbatim.
    """
    service = _get_service()
    try:
        task = await service.show_task(task_id)
    except HermesKanbanError as exc:
        log.warning(
            "hermes_kanban_show_failed",
            task_id=task_id,
            error=str(exc),
            exit_code=exc.exit_code,
        )
        raise _service_error_to_http(exc) from exc
    return JSONResponse(task.to_dict())


@router.post(
    "/work/hermes/kanban/{task_id}/cancel",
    dependencies=[Depends(verify_secret)],
    response_model=KanbanActionResponse,
)
async def cancel_kanban_task(
    task_id: str = Path(..., min_length=1, max_length=128),
) -> KanbanActionResponse:
    """Cancel (block) a kanban task.

    The service issues ``hermes kanban block <id>`` and flips the
    Supabase mirror status to ``cancelled``. Returns 200 with an
    ack payload; failures bubble up as 502.
    """
    service = _get_service()
    try:
        await service.cancel_task(task_id)
    except HermesKanbanError as exc:
        log.warning(
            "hermes_kanban_cancel_failed",
            task_id=task_id,
            error=str(exc),
            exit_code=exc.exit_code,
        )
        raise _service_error_to_http(exc) from exc
    return KanbanActionResponse(task_id=task_id, action="cancel")


@router.post(
    "/work/hermes/kanban/{task_id}/retry",
    dependencies=[Depends(verify_secret)],
    response_model=KanbanActionResponse,
)
async def retry_kanban_task(
    task_id: str = Path(..., min_length=1, max_length=128),
) -> KanbanActionResponse:
    """Retry a kanban task (reclaim + unblock)."""
    service = _get_service()
    try:
        await service.retry_task(task_id)
    except HermesKanbanError as exc:
        log.warning(
            "hermes_kanban_retry_failed",
            task_id=task_id,
            error=str(exc),
            exit_code=exc.exit_code,
        )
        raise _service_error_to_http(exc) from exc
    return KanbanActionResponse(task_id=task_id, action="retry")


# ---------------------------------------------------------------------------
# SSE event tail
# ---------------------------------------------------------------------------


# Heartbeat cadence for idle SSE connections — same 15s value as the
# other streaming endpoints (chat_stream.py, pipeline.py). Keeps
# corporate proxies from closing a quiet stream.
_HEARTBEAT_INTERVAL_S = 15.0


async def _sse_wrap(
    service: HermesKanbanService,
    task_id: str,
) -> AsyncIterator[bytes]:
    """Wrap the service's tail iterator with SSE framing + heartbeats.

    We tee the events through an asyncio.Queue so a separate timer
    coroutine can fire a ``: keepalive`` comment whenever the upstream
    has been quiet for the heartbeat interval. This mirrors the
    heartbeat pattern in chat_stream._stream_with_heartbeat — keeping
    the same shape across SSE endpoints means the Next.js consumer
    can use one reader for all of them.

    Each event is encoded as ``data: <json>\\n\\n`` on a single SSE
    frame. A trailing ``data: {"type":"stream_end"}`` is emitted when
    the upstream iterator terminates so the front-end can close the
    connection cleanly without waiting on a transport timeout.
    """
    queue: asyncio.Queue[dict[str, Any] | None] = asyncio.Queue()

    async def produce() -> None:
        try:
            async for event in service.tail_events(task_id):
                await queue.put(event)
        finally:
            await queue.put(None)

    producer = asyncio.create_task(produce())
    try:
        while True:
            getter = asyncio.create_task(queue.get())
            done, _pending = await asyncio.wait(
                {getter},
                timeout=_HEARTBEAT_INTERVAL_S,
                return_when=asyncio.FIRST_COMPLETED,
            )
            if not done:
                getter.cancel()
                yield b": keepalive\n\n"
                continue
            event = getter.result()
            if event is None:
                yield b'data: {"type":"stream_end"}\n\n'
                return
            yield f"data: {json.dumps(event)}\n\n".encode("utf-8")
    finally:
        producer.cancel()
        try:
            await producer
        except (asyncio.CancelledError, Exception):  # noqa: BLE001
            pass


@router.get(
    "/work/hermes/kanban/{task_id}/events",
    dependencies=[Depends(verify_secret)],
)
async def stream_kanban_events(
    task_id: str = Path(..., min_length=1, max_length=128),
) -> StreamingResponse:
    """SSE stream of Hermes kanban events for one task.

    Connection stays open until Hermes closes the tail (task reached
    terminal state) or the client disconnects. The browser-side
    consumer uses a plain ``fetch`` + ``ReadableStream`` reader,
    matching the existing chat / pipeline SSE shape.
    """
    service = _get_service()
    return StreamingResponse(
        _sse_wrap(service, task_id),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


__all__ = [
    "router",
    "set_service",
    "KanbanCreateInput",
    "KanbanCreateResponse",
    "KanbanActionResponse",
]
