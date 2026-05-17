"""Streaming chat-with-Ekko routes (Wave 5).

Lives separate from :mod:`worker.src.routes.chat` (the placeholder for
non-streaming agent-loop endpoints) so the SSE machinery can evolve
independently of the future batch /work/chat handler.

Two endpoints:

  POST /work/chat/creative
      body: { creative_id, messages, tools? }
      Streams Server-Sent Events for the chat-with-Ekko side panel of an
      image creative.

  POST /work/chat/video-creative
      body: { creative_id, messages, tools? }
      Same shape, different default tool set, for the video pipeline.

The SSE wire format is one event per line of the form ``data: {json}\\n``,
following the standard HTML5 SSE spec but consumed by the Next.js side
via plain ``fetch`` + ``ReadableStream`` (the browser-side EventSource
class doesn't support POST). The ``data:`` JSON shape mirrors
:class:`worker.src.services.claude_runner.StreamChunk`:

    { "type": "text_delta",        "delta": "..." }
    { "type": "tool_call_start",   "tool": "...", "input": {...} }
    { "type": "tool_call_result",  "tool": "...", "result": {...} }
    { "type": "message_stop" }
    { "type": "error",             "message": "..." }

Heartbeat lines (``: keepalive\\n\\n``) are emitted every 15s while the
upstream stream is quiet, so corporate proxies don't kill an idle
connection.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator
from typing import Any, Literal

import structlog
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from ..auth import verify_secret
from ..services.claude_runner import ClaudeRunner, StreamChunk


log = structlog.get_logger(__name__)


router = APIRouter()


# Number of seconds between SSE keepalive comments. 15s sits comfortably
# below the 30s default idle timeout most proxies enforce.
_HEARTBEAT_INTERVAL_S = 15.0


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------


class ChatMessage(BaseModel):
    """One message in the chat history.

    Anthropic SDK expects ``content`` to be a string OR a list of typed
    blocks; for the v1 chat UI we only need strings, so the schema
    enforces that. The route translates to the SDK shape at the call site.
    """

    role: Literal["user", "assistant"]
    content: str = Field(..., min_length=1)


class ToolSpec(BaseModel):
    """One tool definition to expose to the agent.

    Mirrors the Anthropic SDK tool-use shape: ``name``, ``description``,
    and an ``input_schema`` jsonschema. We accept it as-is so the front
    end can declare custom tools without round-tripping through the
    worker. The default tool sets (see ``_default_image_tools`` /
    ``_default_video_tools``) are injected when ``tools`` is omitted.
    """

    name: str = Field(..., min_length=1)
    description: str = ""
    input_schema: dict[str, Any] = Field(default_factory=dict)


class ChatStreamInput(BaseModel):
    """POST body for both image + video streaming chat routes."""

    creative_id: str = Field(..., min_length=1)
    messages: list[ChatMessage]
    tools: list[ToolSpec] | None = None
    system_prompt: str | None = None


# ---------------------------------------------------------------------------
# Default tool sets
# ---------------------------------------------------------------------------


def _default_image_tools() -> list[dict[str, Any]]:
    """Tools the image-creative chat exposes by default."""
    return [
        {
            "name": "regenerate_image",
            "description": (
                "Regenerate the current image creative with a new prompt. "
                "Use when the operator asks for a re-render with adjusted "
                "wording, mood, or composition."
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "prompt": {"type": "string", "description": "New image prompt."},
                    "ratio": {
                        "type": "string",
                        "enum": ["1x1", "9x16"],
                        "description": "Output ratio.",
                    },
                },
                "required": ["prompt"],
            },
        },
        {
            "name": "composite_image",
            "description": (
                "Add overlay text / banner / CTA to the current image. "
                "Uses the local image_compositor.py."
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "style": {
                        "type": "string",
                        "enum": ["bold-bottom", "offer-banner", "full-overlay", "minimal"],
                    },
                    "headline": {"type": "string"},
                    "cta": {"type": "string"},
                },
                "required": ["headline"],
            },
        },
    ]


def _default_video_tools() -> list[dict[str, Any]]:
    """Tools the video-creative chat exposes by default."""
    return [
        {
            "name": "regenerate_voiceover",
            "description": "Re-run ElevenLabs TTS with a new voice or script.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "voice_id": {"type": "string"},
                    "script": {"type": "string"},
                },
            },
        },
        {
            "name": "swap_broll",
            "description": "Replace the b-roll clip at a given segment index.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "segment_idx": {"type": "integer"},
                    "clip_id": {"type": "string"},
                },
                "required": ["segment_idx", "clip_id"],
            },
        },
        {
            "name": "rerender_video",
            "description": "Re-run the ffmpeg composite stage.",
            "input_schema": {"type": "object", "properties": {}},
        },
    ]


# ---------------------------------------------------------------------------
# Stream plumbing
# ---------------------------------------------------------------------------


# Allow tests to substitute the runner without monkey-patching the import.
_runner: ClaudeRunner | None = None


def _get_runner() -> ClaudeRunner:
    global _runner
    if _runner is None:
        _runner = ClaudeRunner()
    return _runner


def _reset_runner() -> None:
    """Test helper — drop the singleton runner."""
    global _runner
    _runner = None


def _format_sse(chunk: StreamChunk) -> bytes:
    """Encode one StreamChunk as a single ``data:`` SSE line + blank line."""
    return f"data: {json.dumps(chunk.to_dict())}\n\n".encode("utf-8")


async def _stream_with_heartbeat(
    runner: ClaudeRunner,
    *,
    messages: list[dict[str, Any]],
    tools: list[dict[str, Any]] | None,
    system_prompt: str | None,
) -> AsyncIterator[bytes]:
    """Wrap the runner's stream with periodic heartbeat lines.

    The heartbeat is an SSE comment (``: keepalive``) — well-formed,
    semantically a no-op, recognised by the browser fetch+stream reader,
    and small enough to be cheap.

    Implementation uses ``asyncio.wait`` to race the next stream chunk
    against the heartbeat tick. If the heartbeat wins we emit it and
    keep waiting; if the chunk wins we emit it and re-arm the timer.
    """
    queue: asyncio.Queue[StreamChunk | None] = asyncio.Queue()

    async def produce() -> None:
        try:
            async for chunk in runner.stream(
                messages, tools=tools, system_prompt=system_prompt
            ):
                await queue.put(chunk)
        finally:
            await queue.put(None)

    saw_terminal = False
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
                # Timed out → emit a heartbeat and loop. Cancel the
                # getter so we re-issue a fresh one next iteration.
                getter.cancel()
                yield b": keepalive\n\n"
                continue
            chunk = getter.result()
            if chunk is None:
                # Producer finished — drain.
                break
            if chunk.type in ("message_stop", "error"):
                saw_terminal = True
            yield _format_sse(chunk)
        # If the underlying runner didn't emit a terminal frame, stamp one
        # so the browser stream reader always sees a clean close.
        if not saw_terminal:
            yield _format_sse(StreamChunk(type="message_stop"))
    finally:
        producer.cancel()
        try:
            await producer
        except (asyncio.CancelledError, Exception):  # noqa: BLE001
            pass


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


def _build_system_prompt(kind: Literal["image", "video"], creative_id: str) -> str:
    """Default system prompt for the chat agent.

    Kept short — the routes are designed to be called by a Next.js layer
    that may inject its own context (the SidePanel.tsx side, with the
    full creative metadata in the user message). The system prompt
    fixes Ekko's persona and the available tools.
    """
    if kind == "image":
        return (
            "You are Ekko, the operator's creative assistant. The current "
            f"creative is image_id={creative_id}. Available tools let you "
            "regenerate the image with new prompts or composite overlays. "
            "Keep replies short and decisive."
        )
    return (
        "You are Ekko, the operator's creative assistant. The current "
        f"creative is video_id={creative_id}. Available tools let you "
        "regenerate the voiceover, swap a single b-roll clip, or re-render "
        "the full video. Keep replies short and decisive."
    )


@router.post("/work/chat/creative", dependencies=[Depends(verify_secret)])
async def chat_image_creative(body: ChatStreamInput) -> StreamingResponse:
    """SSE stream for chat-with-Ekko on an image creative."""
    return _stream_chat(body, kind="image")


@router.post("/work/chat/video-creative", dependencies=[Depends(verify_secret)])
async def chat_video_creative(body: ChatStreamInput) -> StreamingResponse:
    """SSE stream for chat-with-Ekko on a video creative."""
    return _stream_chat(body, kind="video")


def _stream_chat(
    body: ChatStreamInput, *, kind: Literal["image", "video"]
) -> StreamingResponse:
    if not body.messages:
        raise HTTPException(status_code=400, detail="messages must not be empty")

    runner = _get_runner()
    tools = (
        [t.model_dump() for t in body.tools]
        if body.tools is not None
        else (_default_image_tools() if kind == "image" else _default_video_tools())
    )
    system = body.system_prompt or _build_system_prompt(kind, body.creative_id)
    messages = [m.model_dump() for m in body.messages]

    log.info(
        "chat_stream_open",
        kind=kind,
        creative_id=body.creative_id,
        message_count=len(messages),
        tool_count=len(tools),
    )

    return StreamingResponse(
        _stream_with_heartbeat(
            runner,
            messages=messages,
            tools=tools,
            system_prompt=system,
        ),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            # Disable buffering on nginx-style proxies.
            "X-Accel-Buffering": "no",
        },
    )
