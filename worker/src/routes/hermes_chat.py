"""SSE route exposing :class:`HermesBridge` over HTTP.

The dashboard's Next.js layer proxies chat messages to this endpoint;
each request runs ``hermes chat -q <last_user_message>`` inside the
sibling ``hermes-agent-ekko`` container via the Docker socket, and the
worker streams stdout back as Server-Sent Events.

Wire format mirrors the existing :mod:`worker.src.routes.chat_stream`
SSE shape so the front-end deserializer stays a single shared module:

    data: {"type": "text_delta", "delta": "..."}
    data: {"type": "message_stop"}
    data: {"type": "error", "message": "..."}

A companion ``POST /work/hermes/chat/abort`` route flips a SIGTERM into
the live exec for a session — the streaming generator unwinds naturally
once Hermes' stdout closes.
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator

import structlog
from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

from ..auth import verify_secret
from ..services.hermes_bridge import HermesBridge, HermesBridgeError


log = structlog.get_logger(__name__)


router = APIRouter(
    prefix="/work/hermes",
    dependencies=[Depends(verify_secret)],
)


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------


class ChatMessage(BaseModel):
    """One message in the chat history.

    Hermes' CLI takes a single prompt argument, so the route's job is
    to pick which message in the history becomes ``-q "<prompt>"``.
    The pragmatic choice — and the one the dashboard expects — is the
    most recent ``user`` message. Earlier turns are retained on the
    Hermes side via the ``--pass-session-id`` flag, which keeps the
    conversation state inside the agent container.
    """

    role: str = Field(..., min_length=1)
    content: str = Field(..., min_length=1)


class ChatRequest(BaseModel):
    """POST body for ``/work/hermes/chat``."""

    messages: list[ChatMessage]
    session_id: str | None = None
    system_prompt: str | None = None


class AbortRequest(BaseModel):
    """POST body for ``/work/hermes/chat/abort``."""

    session_id: str = Field(..., min_length=1)


# ---------------------------------------------------------------------------
# Bridge singleton
# ---------------------------------------------------------------------------


# A module-level slot lets tests substitute a fake bridge by assigning
# directly to ``_bridge`` (or calling ``_reset_bridge``). Production code
# never touches the slot — :func:`_get_bridge` constructs the singleton
# lazily on first request so importing the route doesn't open the Docker
# socket at module-load time.
_bridge: HermesBridge | None = None


def _get_bridge() -> HermesBridge:
    """Return the lazily-constructed bridge singleton."""
    global _bridge
    if _bridge is None:
        _bridge = HermesBridge()
    return _bridge


def _reset_bridge() -> None:
    """Drop the singleton — test helper."""
    global _bridge
    _bridge = None


# ---------------------------------------------------------------------------
# SSE encoding
# ---------------------------------------------------------------------------


def _sse(payload: dict) -> bytes:
    """Encode one payload as a single ``data:`` SSE frame."""
    return f"data: {json.dumps(payload)}\n\n".encode("utf-8")


def _last_user_message(messages: list[ChatMessage]) -> str:
    """Pick the most recent ``user`` message's content.

    Returns ``""`` if no user message is present; the caller treats
    an empty prompt as "nothing to ask" and short-circuits to a
    terminal SSE frame rather than spawning a Hermes exec that would
    do nothing useful.
    """
    for msg in reversed(messages):
        if msg.role == "user":
            return msg.content
    return ""


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@router.post("/chat")
async def chat(req: ChatRequest) -> StreamingResponse:
    """Open an SSE stream for one ``hermes chat`` invocation."""
    prompt = _last_user_message(req.messages)
    bridge = _get_bridge()
    session_id = req.session_id
    system_prompt = req.system_prompt

    log.info(
        "hermes_chat_open",
        session_id=session_id,
        message_count=len(req.messages),
        prompt_len=len(prompt),
    )

    async def stream() -> AsyncIterator[bytes]:
        # Empty user message → nothing to send to Hermes; emit a clean
        # terminal frame so the front-end's stream reader closes
        # without surprises.
        if not prompt:
            yield _sse({"type": "message_stop"})
            return
        try:
            async for chunk in bridge.chat_stream(
                prompt, session_id=session_id, system_prompt=system_prompt
            ):
                yield _sse(
                    {
                        "type": "text_delta",
                        "delta": chunk.decode("utf-8", "replace"),
                    }
                )
        except HermesBridgeError as exc:
            log.warning(
                "hermes_chat_bridge_error",
                session_id=session_id,
                error=str(exc),
            )
            yield _sse({"type": "error", "message": str(exc)})
        yield _sse({"type": "message_stop"})

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            # Disable buffering on nginx-style proxies so chunks reach
            # the browser as soon as Hermes flushes them.
            "X-Accel-Buffering": "no",
        },
    )


@router.post("/chat/abort")
async def chat_abort(req: AbortRequest) -> JSONResponse:
    """Send SIGTERM into the live ``hermes chat`` exec for a session.

    Returns ``{"aborted": true}`` with 200 when a live exec was found
    and signalled; ``{"aborted": false}`` with 404 when there's no
    matching session (per HI-2 acceptance criteria: "404 if not found").
    """
    bridge = _get_bridge()
    ok = await bridge.abort(req.session_id)
    log.info(
        "hermes_chat_abort", session_id=req.session_id, found=ok
    )
    status_code = 200 if ok else 404
    return JSONResponse({"aborted": ok}, status_code=status_code)
