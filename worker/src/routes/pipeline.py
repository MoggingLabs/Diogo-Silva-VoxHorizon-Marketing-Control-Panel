"""Pipeline-stage worker routes (Wave 10 / PF-B).

The Configuration stage of the pipeline lets the operator either fill in the
image / video brief forms by hand or run an Ekko "brief-strategist" interview
that proposes a fully-shaped draft via a single tool call.

This module currently exposes one endpoint:

  POST /work/pipeline/config-draft
      body: { pipeline_id, format_choice, messages, tools?, system_prompt? }
      Streams SSE chunks (same wire format as the chat_stream routes).
      Ekko asks the operator about service, market, budget, audience, offer,
      and angles. When it's confident it has enough material it calls the
      single tool ``propose_config``; the route translates that into a
      ``tool_call_result`` SSE frame so the Next.js modal can hydrate the
      form.

Tool schema (matches the brief / video_brief payload shapes the Next.js form
parses on submit):

  propose_config({
    format_choice: 'image' | 'video' | 'both',
    image_payload: { ... } | null,
    video_payload: { ... } | null,
    notes?: str
  })

Future endpoints (Wave 11+):

  POST /work/pipeline/ideation       — kick off the ideation worker.
  POST /work/pipeline/generation     — fire image/video creative workers.

Both are stubbed out so the Next.js advance route can fire-and-forget without
breaking when the worker doesn't yet implement them.
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
from ..services.chat_abort import get_store
from ..services.claude_runner import ClaudeRunner, StreamChunk


log = structlog.get_logger(__name__)


router = APIRouter()


# Same heartbeat cadence as chat_stream — keeps idle SSE connections alive
# behind proxy timeouts.
_HEARTBEAT_INTERVAL_S = 15.0


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------


class ChatMessage(BaseModel):
    """One turn of the Ekko interview transcript."""

    role: Literal["user", "assistant"]
    content: str = Field(..., min_length=1)


class ToolSpec(BaseModel):
    """One tool definition forwarded from Next.js, mirroring the SDK shape."""

    name: str = Field(..., min_length=1)
    description: str = ""
    input_schema: dict[str, Any] = Field(default_factory=dict)


class ConfigDraftInput(BaseModel):
    """POST body for ``/work/pipeline/config-draft``."""

    pipeline_id: str = Field(..., min_length=1)
    # Forwarded so the system prompt can constrain Ekko to the right
    # format. The Next.js proxy reads it off the pipeline row.
    format_choice: Literal["image", "video", "both"] = "both"
    messages: list[ChatMessage]
    tools: list[ToolSpec] | None = None
    system_prompt: str | None = None


# ---------------------------------------------------------------------------
# Default tool — propose_config
# ---------------------------------------------------------------------------


def _propose_config_tool() -> dict[str, Any]:
    """The single tool Ekko calls when it's ready to hand a draft over.

    The input_schema is deliberately permissive — we accept missing fields
    so Ekko can propose partial drafts (the operator fills in the rest) and
    pass-through the optional payload keys without re-listing every brief
    field here. The Next.js modal forwards the result verbatim to the form;
    canonical validation happens at advance time via the BriefPayload /
    VideoBriefInput zod schemas.
    """
    return {
        "name": "propose_config",
        "description": (
            "Propose a Configuration-stage draft for the current pipeline. "
            "Call this exactly once when you have enough information from "
            "the operator to fill in the form. Pass image_payload only if "
            "the format is image or both; video_payload only if video or "
            "both. Include a short rationale in `notes`."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "format_choice": {
                    "type": "string",
                    "enum": ["image", "video", "both"],
                    "description": (
                        "The format the operator should target. Usually "
                        "matches what they started with, but you may "
                        "suggest a different one if the brief calls for it."
                    ),
                },
                "image_payload": {
                    "type": ["object", "null"],
                    "description": (
                        "Image brief payload — fields match the BriefForm. "
                        "Pass null for video-only pipelines."
                    ),
                    "additionalProperties": True,
                },
                "video_payload": {
                    "type": ["object", "null"],
                    "description": (
                        "Video brief payload — fields match the "
                        "VideoBriefForm. Pass null for image-only pipelines."
                    ),
                    "additionalProperties": True,
                },
                "notes": {
                    "type": "string",
                    "description": "Short rationale for the operator.",
                },
            },
            "required": ["format_choice"],
        },
    }


def _default_tools() -> list[dict[str, Any]]:
    """Default tool set for the brief-strategist interview."""
    return [_propose_config_tool()]


# ---------------------------------------------------------------------------
# System prompt
# ---------------------------------------------------------------------------


def _system_prompt(format_choice: str, pipeline_id: str) -> str:
    """Brief-strategist persona prompt.

    Kept terse — Ekko's job is to ask 3–5 high-signal questions and then
    call propose_config once. We name the target format so it doesn't
    propose a payload for a track that's disabled.
    """
    tracks: list[str] = []
    if format_choice in ("image", "both"):
        tracks.append("image")
    if format_choice in ("video", "both"):
        tracks.append("video")
    tracks_str = " + ".join(tracks) if tracks else "image"

    return (
        "You are Ekko, the operator's brief strategist. The current pipeline "
        f"is `{pipeline_id}` and is configured for `{tracks_str}` creative(s). "
        "Interview the operator with short, focused questions covering: "
        "(1) service line (roofing vs remodeling), (2) target market / city, "
        "(3) total + daily budget in USD, (4) audience targeting (radius, age "
        "range, ZIPs), (5) offer / CTA, and (6) creative angles. Keep each "
        "reply under two sentences. After three to five exchanges, call the "
        "`propose_config` tool exactly once with a complete draft. Do NOT "
        "call the tool more than once. After the tool call, stop."
    )


# ---------------------------------------------------------------------------
# Stream plumbing
# ---------------------------------------------------------------------------


# Module-level runner singleton — same pattern as chat_stream.py so tests can
# swap it without monkey-patching the import.
_runner: ClaudeRunner | None = None


def _get_runner() -> ClaudeRunner:
    global _runner
    if _runner is None:
        _runner = ClaudeRunner()
    return _runner


def _reset_runner() -> None:
    """Test helper — drop the singleton runner so a fresh fake can take over."""
    global _runner
    _runner = None


def _format_sse(chunk: StreamChunk) -> bytes:
    """Encode one StreamChunk as a single ``data:`` SSE line + blank line."""
    return f"data: {json.dumps(chunk.to_dict())}\n\n".encode("utf-8")


async def _stream_with_propose_detection(
    runner: ClaudeRunner,
    *,
    pipeline_id: str,
    messages: list[dict[str, Any]],
    tools: list[dict[str, Any]],
    system_prompt: str,
) -> AsyncIterator[bytes]:
    """Wrap the runner stream, detect propose_config tool calls, and
    emit a synthetic ``tool_call_result`` frame so the front end can
    hydrate the form without a second round-trip.

    The Anthropic SDK reports a tool invocation as a ``tool_call_start``
    StreamChunk (carrying the full input dict by the time we see the
    ``content_block.type == 'tool_use'`` event). For ``propose_config``
    we intercept that frame, stamp it onto the wire as-is, then
    immediately fire a matching ``tool_call_result`` so the modal
    receives the same payload via the documented result channel.

    Heartbeat behaviour mirrors chat_stream's wrapper (a `: keepalive`
    comment every 15s).

    Abort signal: we reuse the ChatAbortStore with `kind='image'` keyed
    on the pipeline_id. The Next.js modal aborts by closing the SSE
    connection (no separate abort endpoint shipped for pipeline drafts
    in PF-B — the connection-level cancel is enough since the stream is
    typically short).
    """
    queue: asyncio.Queue[StreamChunk | None] = asyncio.Queue()
    store = get_store()
    store.clear("image", f"pipeline:{pipeline_id}")

    async def produce() -> None:
        try:
            async for chunk in runner.stream(
                messages, tools=tools, system_prompt=system_prompt
            ):
                await queue.put(chunk)
        finally:
            await queue.put(None)

    saw_terminal = False
    aborted = False
    producer = asyncio.create_task(produce())
    try:
        while True:
            if store.is_aborted("image", f"pipeline:{pipeline_id}"):
                aborted = True
                yield _format_sse(StreamChunk(type="message_stop"))
                saw_terminal = True
                break

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
            chunk = getter.result()
            if chunk is None:
                break

            if chunk.type in ("message_stop", "error"):
                saw_terminal = True

            # Forward every chunk verbatim.
            yield _format_sse(chunk)

            # When the SDK reports a full tool_use block for our
            # propose_config tool, synthesize the matching tool_call_result
            # so the front end's existing chunk parser fires onProposed.
            if (
                chunk.type == "tool_call_start"
                and chunk.tool == "propose_config"
                and isinstance(chunk.input, dict)
            ):
                yield _format_sse(
                    StreamChunk(
                        type="tool_call_result",
                        tool="propose_config",
                        result=chunk.input,
                    )
                )

        if not saw_terminal:
            yield _format_sse(StreamChunk(type="message_stop"))
    finally:
        producer.cancel()
        try:
            await producer
        except (asyncio.CancelledError, Exception):  # noqa: BLE001
            pass
        store.clear("image", f"pipeline:{pipeline_id}")
        if aborted:
            log.info("pipeline_config_draft_aborted", pipeline_id=pipeline_id)


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@router.post(
    "/work/pipeline/config-draft", dependencies=[Depends(verify_secret)]
)
async def config_draft_stream(body: ConfigDraftInput) -> StreamingResponse:
    """SSE stream of an Ekko brief-strategist interview.

    The route is short on its own; the heavy lifting lives in
    :func:`_stream_with_propose_detection`. Validation is handled by
    Pydantic; an empty `messages` array returns 400 explicitly because
    the Anthropic SDK rejects empty histories with a 400 of its own and
    the clearer 400 here surfaces the cause sooner.
    """
    if not body.messages:
        raise HTTPException(status_code=400, detail="messages must not be empty")

    runner = _get_runner()
    tools = (
        [t.model_dump() for t in body.tools]
        if body.tools is not None
        else _default_tools()
    )
    system = body.system_prompt or _system_prompt(body.format_choice, body.pipeline_id)
    messages = [m.model_dump() for m in body.messages]

    log.info(
        "pipeline_config_draft_open",
        pipeline_id=body.pipeline_id,
        format_choice=body.format_choice,
        message_count=len(messages),
        tool_count=len(tools),
    )

    return StreamingResponse(
        _stream_with_propose_detection(
            runner,
            pipeline_id=body.pipeline_id,
            messages=messages,
            tools=tools,
            system_prompt=system,
        ),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
