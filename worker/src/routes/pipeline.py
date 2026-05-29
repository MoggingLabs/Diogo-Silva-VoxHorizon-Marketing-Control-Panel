"""Pipeline-stage worker routes (Wave 10 / PF-B + Wave 11 / PF-C/E).

The Pipeline feature is a guided multi-step ad-creation flow. This
module hosts the worker-side endpoints the Next.js app fires at, one
per stage of the state machine:

  POST /work/pipeline/config-draft   (PF-B)
      body: { pipeline_id, format_choice, messages, tools?, system_prompt? }
      Streams SSE chunks (same wire format as the chat_stream routes).
      Ekko asks the operator about service, market, budget, audience, offer,
      and angles. When it's confident it has enough material it calls the
      single tool ``propose_config``; the route translates that into a
      ``tool_call_result`` SSE frame so the Next.js modal can hydrate the
      form.

  POST /work/pipeline/ideation       (PF-C-2)
      body: { pipeline_id }
      Returns 200 immediately while a background coroutine produces
      cheap concept variants (N=4 1:1 Kie.ai renders for the image
      track, N=3 script-only drafts for the video track). Each variant
      lands as one ``creatives`` / ``video_creatives`` row plus a
      ``pipeline_events(kind='task_done', stage='ideation')`` row so
      the timeline UI updates in realtime. Idempotent: a second click
      during the same stage entry returns ``{ already_run: true }``
      without re-producing.

  POST /work/pipeline/generation     (PF-E-1 + PF-D-5 idempotency)
      body: { pipeline_id }
      Orchestrates the *final* renders for everything in ``pipeline.picks``.
      Image picks get two Kie.ai renders each (1:1 + 9:16, serial
      per-brief). Video picks fan out through voiceover → broll-search →
      broll-pick → compose → caption with per-substage task events.
      Each paid external call emits a ``cost_recorded`` event. Two
      back-to-back calls reduce to one run via the idempotency probe.

Tool schema for ``propose_config`` (matches the brief / video_brief
payload shapes the Next.js form parses on submit):

  propose_config({
    format_choice: 'image' | 'video' | 'both',
    image_payload: { ... } | null,
    video_payload: { ... } | null,
    notes?: str
  })

The heavier orchestration helpers live in
:mod:`worker.src.services.pipeline_runner` so this route file stays
thin.
"""

from __future__ import annotations

import asyncio
import json
import uuid
from collections.abc import AsyncIterator
from typing import Any, Literal

import structlog
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from ..auth import verify_secret
from ..services import cost_ledger
from ..services.atomic_inserts import record_creative_stage
from ..services.atomic_inserts_video import record_video_stage
from ..services.chat_abort import get_store
from ..services.claude_runner import ClaudeRunner, StreamChunk
from ..services.kie import KieClient, KieError
from ..services.pipeline_runner import (
    EVENT_TASK_DONE,
    EVENT_TASK_ERROR,
    EVENT_TASK_QUEUED,
    EVENT_TASK_RUNNING,
    PipelineCancelled,
    emit_cost,
    emit_pipeline_event,
    fetch_pipeline,
    generation_state,
    ideation_already_ran,
    picks_from_pipeline,
    pipeline_is_cancelled,
)
from ..services.queue import get_queue
from ..services.storage import BUCKET, build_creative_path
from ..supabase_client import get_supabase_admin


log = structlog.get_logger(__name__)


router = APIRouter()


# Same heartbeat cadence as chat_stream — keeps idle SSE connections alive
# behind proxy timeouts.
_HEARTBEAT_INTERVAL_S = 15.0


# Per-image Kie.ai render cost (USD). These are the SAME figures emit_cost
# records as the ACTUAL ledger spend after each render; sharing one constant
# per stage keeps the pre-flight reservation (cost_ledger.reserve_budget, the
# E4.4 #506 hard cap) and the recorded amount in lockstep so the cap reserves
# exactly what the render goes on to spend. Ideation renders at 1K (cheap
# concept previews); generation renders at 2K (final assets).
IDEATION_IMAGE_COST_USD = 0.02
GENERATION_IMAGE_COST_USD = 0.05


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


# ===========================================================================
# PF-C-2 — POST /work/pipeline/ideation
# ===========================================================================
#
# Ideation produces *cheap* preview variants the operator picks from at
# the Review stage. We're explicitly trading variety for spend here:
#
#   * Image track: N=4 concepts; ONE 1:1 Kie.ai render per concept (no
#     9:16 — the operator only needs to see the visual idea; the 9:16
#     render comes at Generation when the concept is locked).
#   * Video track: N=3 script + b-roll-plan drafts. NO voiceover /
#     compose / caption — those are paid stages that don't run until
#     Generation.
#
# Each variant lands as one ``creatives`` / ``video_creatives`` row plus
# a matching ``pipeline_events(kind='task_done', stage='ideation')``
# event. The events table is the UI's realtime feed; the rows
# themselves drive the Review picker.
#
# Long-running: we fire-and-forget the producer onto FastAPI's
# ``BackgroundTasks`` and return 200 immediately. The operator sees
# progress through the events table (Realtime → Next.js).
#
# Status enum note: the image_creative_status enum (migration 0001) has
# no 'ideation_draft' / 'pending_review' value — its values are
# 'draft' / 'approved' / 'rejected' / 'live' / 'killed'. We use 'draft'
# for ideation variants. Same for video_creative_status — the enum has
# 'draft' / 'script_ready' / ... but no 'script_draft', so we use
# 'draft' for ideation drafts. ``record_creative_stage`` /
# ``record_video_stage`` already write 'draft' / stage-appropriate
# status for us so we don't touch the enum here.


# Tuning constants — kept at module scope so they're easy to grep / unit
# test, and so the operator can change the N values without touching the
# producer logic itself.
IDEATION_IMAGE_CONCEPT_COUNT = 4
IDEATION_VIDEO_DRAFT_COUNT = 3


class IdeationInput(BaseModel):
    """POST body for ``/work/pipeline/ideation``."""

    pipeline_id: str = Field(..., min_length=1)


class IdeationAccepted(BaseModel):
    """Response body for ``/work/pipeline/ideation``.

    ``accepted`` means "we kicked off the background producer"; the
    operator should poll ``pipeline_events`` / Realtime for progress.
    """

    pipeline_id: str
    accepted: bool = True
    already_run: bool = False
    image_track: bool = False
    video_track: bool = False


@router.post(
    "/work/pipeline/ideation", dependencies=[Depends(verify_secret)]
)
async def run_ideation(
    body: IdeationInput, background: BackgroundTasks
) -> IdeationAccepted:
    """Kick off cheap concept production for a pipeline's ideation stage.

    Returns 200 immediately. If the latest ``stage_advanced→ideation``
    has already produced events (any ``task_*`` row), the call is
    treated as idempotent and ``already_run=true`` is returned without
    queuing another producer. This matches the PF-D-5-style guard the
    generation endpoint applies; ideation has the same retrigger
    problem since the Next.js advance route fires-and-forgets.
    """
    pipeline = fetch_pipeline(body.pipeline_id)
    if not pipeline:
        raise HTTPException(
            status_code=404, detail=f"pipeline not found: {body.pipeline_id}"
        )

    format_choice = str(pipeline.get("format_choice") or "image")
    image_track = format_choice in ("image", "both") and pipeline.get("image_brief_id")
    video_track = format_choice in ("video", "both") and pipeline.get("video_brief_id")

    if ideation_already_ran(body.pipeline_id):
        log.info(
            "pipeline_ideation_idempotent_skip",
            pipeline_id=body.pipeline_id,
            format_choice=format_choice,
        )
        return IdeationAccepted(
            pipeline_id=body.pipeline_id,
            accepted=True,
            already_run=True,
            image_track=bool(image_track),
            video_track=bool(video_track),
        )

    # Queue the producer onto BackgroundTasks. Each track runs as its
    # own coroutine so an image-track failure doesn't block the video
    # track from running, and vice versa. The producers emit their own
    # events; the HTTP layer is done after this return.
    if image_track:
        background.add_task(
            _produce_ideation_image_track,
            pipeline_id=body.pipeline_id,
            brief_id=str(pipeline["image_brief_id"]),
        )
    if video_track:
        background.add_task(
            _produce_ideation_video_track,
            pipeline_id=body.pipeline_id,
            brief_id=str(pipeline["video_brief_id"]),
        )

    log.info(
        "pipeline_ideation_kicked",
        pipeline_id=body.pipeline_id,
        image_track=bool(image_track),
        video_track=bool(video_track),
    )
    return IdeationAccepted(
        pipeline_id=body.pipeline_id,
        accepted=True,
        already_run=False,
        image_track=bool(image_track),
        video_track=bool(video_track),
    )


# ---------------------------------------------------------------------------
# Image track ideation producer
# ---------------------------------------------------------------------------


def _fetch_image_brief(brief_id: str) -> dict[str, Any] | None:
    """Pull the image brief row + client metadata. None if missing."""
    sb = get_supabase_admin()
    resp = (
        sb.table("briefs")
        .select(
            "id, brief_id_human, status, payload, "
            "clients(id, slug, name, service_type)"
        )
        .eq("id", brief_id)
        .maybe_single()
        .execute()
    )
    return resp.data if isinstance(resp.data, dict) else None


def _fetch_video_brief(brief_id: str) -> dict[str, Any] | None:
    """Pull the video brief row + client metadata. None if missing."""
    sb = get_supabase_admin()
    resp = (
        sb.table("video_briefs")
        .select("*, clients(slug, name)")
        .eq("id", brief_id)
        .maybe_single()
        .execute()
    )
    return resp.data if isinstance(resp.data, dict) else None


def _fallback_image_concepts(
    brief: dict[str, Any], *, count: int
) -> list[dict[str, str]]:
    """Synthesize a deterministic set of concepts from the brief payload.

    Used when the Claude agent path can't be reached (offline tests,
    CLI not installed) — we still want the operator to see N variants
    rather than a hard failure. The prompts are simple but on-brief:
    we pull market / offer / service from the payload and assemble a
    short prompt per concept.
    """
    payload = brief.get("payload") or {}
    if not isinstance(payload, dict):
        payload = {}
    market = str(payload.get("market") or "the local market")
    offer = str(payload.get("offer_text") or "a special offer")
    angles_raw = payload.get("angles") or []
    angles = [str(a) for a in angles_raw if isinstance(a, str)]
    if not angles:
        angles = ["before-and-after", "trust", "savings", "urgency"]

    # Pad / trim so we always emit `count` rows.
    seeds = (angles * ((count // max(1, len(angles))) + 1))[:count]
    return [
        {
            "concept": f"ideation-{i + 1}-{seed}",
            "prompt": (
                f"Cheap ideation concept #{i + 1} ({seed}). "
                f"Marketing image for {market}. Offer: {offer}. "
                "Square 1:1 framing, clean composition, ad-ready aesthetic."
            ),
        }
        for i, seed in enumerate(seeds)
    ]


async def _produce_ideation_image_track(
    *,
    pipeline_id: str,
    brief_id: str,
) -> None:
    """Produce N cheap 1:1 image concepts for the image track.

    Each concept is one Kie.ai render at 1:1 only. The per-brief
    BriefQueue serializes the Kie.ai calls (image-generation SOP
    forbids parallel calls within a single brief). After each
    successful render we write the ``creatives`` row via the existing
    atomic-insert helper and emit ``task_done`` + ``cost_recorded``
    pipeline events.

    Failures *per concept* are caught and surfaced as ``task_error``
    events — one Kie.ai 429 shouldn't take down the entire ideation
    run.
    """
    brief = _fetch_image_brief(brief_id)
    if brief is None:
        log.warning(
            "pipeline_ideation_image_brief_missing",
            pipeline_id=pipeline_id,
            brief_id=brief_id,
        )
        emit_pipeline_event(
            pipeline_id=pipeline_id,
            kind=EVENT_TASK_ERROR,
            stage="ideation",
            payload={"kind": "image", "error": f"brief not found: {brief_id}"},
        )
        return

    # Resolve the prompt pack. We default to the deterministic fallback
    # rather than spinning up the Claude agent here — ideation needs to
    # be cheap, fast, and deterministic enough to test without mocks.
    concepts = _fallback_image_concepts(brief, count=IDEATION_IMAGE_CONCEPT_COUNT)

    try:
        kie_client = KieClient()
    except RuntimeError as e:
        log.warning("pipeline_ideation_no_kie_key", pipeline_id=pipeline_id, error=str(e))
        emit_pipeline_event(
            pipeline_id=pipeline_id,
            kind=EVENT_TASK_ERROR,
            stage="ideation",
            payload={"kind": "image", "error": str(e)},
        )
        return

    sb = get_supabase_admin()
    queue = get_queue()

    async with queue.acquire(brief_id):
        for entry in concepts:
            concept = entry["concept"]
            prompt = entry["prompt"]
            emit_pipeline_event(
                pipeline_id=pipeline_id,
                kind=EVENT_TASK_QUEUED,
                stage="ideation",
                payload={"kind": "image", "concept": concept, "ratio": "1x1"},
            )
            running_id = emit_pipeline_event(
                pipeline_id=pipeline_id,
                kind=EVENT_TASK_RUNNING,
                stage="ideation",
                payload={"kind": "image", "concept": concept, "ratio": "1x1"},
            )
            try:
                # E4.4 (#506) per-pipeline HARD CAP: refuse BEFORE the paid
                # render if this concept's estimated spend plus the pipeline's
                # already-recorded ACTUAL spend would exceed the cap. Mirrors
                # the video b-roll submit gate (routes/video.py) so the image
                # track -- the primary production path -- is bounded across
                # retries / many-concept fan-out the same way, and the hard cap
                # holds regardless of approval mode (it reads the real ledger
                # the auto-approve path also writes to). On overrun this raises
                # a 402 caught by the per-concept handler below as a task_error,
                # so an over-cap concept fails its render loudly instead of
                # spending unbounded. The estimate equals the figure emit_cost
                # records after the spend, so the cap reserves exactly what the
                # render costs (reserve = pre-flight read-only check; emit_cost
                # = the actual ledger write -- no double-count).
                try:
                    cost_ledger.reserve_budget(pipeline_id, IDEATION_IMAGE_COST_USD)
                except cost_ledger.BudgetExceeded as exc:
                    raise HTTPException(status_code=402, detail=str(exc)) from exc
                result = await kie_client.generate_image_full(
                    prompt, "1x1", resolution="1K"
                )
                storage_path = build_creative_path(
                    brief_id, concept, "1x1", "v0.ideation"
                )
                sb.storage.from_(BUCKET).upload(
                    path=storage_path,
                    file=result.image_bytes,
                    file_options={
                        "content-type": "image/png",
                        "x-upsert": "true",
                    },
                )
                insert = await record_creative_stage(
                    brief_id=brief_id,
                    file_path_supabase=storage_path,
                    concept=concept,
                    offer_text=None,
                    ratio="1x1",
                    version="v0.ideation",
                    prompt_used={
                        "model": "kie/nano-banana-2",
                        "prompt": prompt,
                        "ratio": "1x1",
                        "resolution": "1K",
                        "task_id": result.task_id,
                        "source_url": result.source_url,
                        "stage": "ideation",
                    },
                    iteration_kind="generate",
                    iteration_content={
                        "prompt": prompt,
                        "task_id": result.task_id,
                        "source_url": result.source_url,
                        "pipeline_id": pipeline_id,
                        "stage": "ideation",
                    },
                    author="ekko",
                )
                done_id = emit_pipeline_event(
                    pipeline_id=pipeline_id,
                    kind=EVENT_TASK_DONE,
                    stage="ideation",
                    payload={
                        "kind": "image",
                        "concept": concept,
                        "ratio": "1x1",
                        "creative_id": insert.creative_id,
                        "file_path_supabase": storage_path,
                    },
                )
                # 1K Kie.ai render cost -- approximate; the aggregator
                # uses these as estimates. The real per-tenant price
                # plumbing lands in PF-F. Same constant the reserve gate
                # above checks, so the recorded ACTUAL matches the reservation.
                emit_cost(
                    pipeline_id=pipeline_id,
                    api="kie.ai",
                    units=1,
                    subtotal=IDEATION_IMAGE_COST_USD,
                    task_event_id=done_id or running_id,
                    stage="ideation",
                    extra={"creative_id": insert.creative_id, "resolution": "1K"},
                )
            except (KieError, RuntimeError, Exception) as e:  # noqa: BLE001
                log.warning(
                    "pipeline_ideation_image_failed",
                    pipeline_id=pipeline_id,
                    brief_id=brief_id,
                    concept=concept,
                    error=str(e),
                )
                emit_pipeline_event(
                    pipeline_id=pipeline_id,
                    kind=EVENT_TASK_ERROR,
                    stage="ideation",
                    payload={
                        "kind": "image",
                        "concept": concept,
                        "ratio": "1x1",
                        "error": str(e),
                    },
                )

    log.info(
        "pipeline_ideation_image_done",
        pipeline_id=pipeline_id,
        brief_id=brief_id,
        concepts=len(concepts),
    )


# ---------------------------------------------------------------------------
# Video track ideation producer
# ---------------------------------------------------------------------------


def _fallback_video_drafts(
    brief: dict[str, Any], *, count: int
) -> list[dict[str, Any]]:
    """Synthesize a deterministic set of video script drafts.

    Same logic as the image-side fallback: avoid hard dependency on
    Claude Code being installed/authenticated so this stage is cheap
    and testable. The shape mirrors the contract the V2 script route
    expects (hook + segments + outro + total_duration_s) so downstream
    stages can read these drafts without translation.
    """
    payload = brief.get("payload") or {}
    if not isinstance(payload, dict):
        payload = {}
    angles_raw = payload.get("angles") or []
    angles = [str(a) for a in angles_raw if isinstance(a, str)]
    if not angles:
        angles = ["before-and-after", "trust", "urgency"]
    hook_style = brief.get("hook_style") or "question"
    duration = int(brief.get("target_duration_s") or 30)

    seeds = (angles * ((count // max(1, len(angles))) + 1))[:count]
    drafts: list[dict[str, Any]] = []
    for i, seed in enumerate(seeds):
        segments = [
            {
                "idx": 0,
                "topic": seed,
                "duration_s": max(5, duration // 3),
                "voiceover_text": (
                    f"Draft #{i + 1}: {seed} hook delivered in {hook_style} style."
                ),
                "voiceover_direction": "natural, confident",
                "broll_query": f"{seed} marketing b-roll",
                "broll_intent": f"establish {seed}",
                "broll_theme": seed,
                "captions_emphasis": [seed],
            }
        ]
        drafts.append(
            {
                "concept": f"video-ideation-{i + 1}-{seed}",
                "script_outline": {
                    "hook": f"What if {seed}?",
                    "segments": segments,
                    "outro": "Call us today.",
                    "total_duration_s": duration,
                },
                "broll_plan": {
                    "segments": [
                        {
                            "idx": s["idx"],
                            "theme": s["broll_theme"],
                            "query": s["broll_query"],
                        }
                        for s in segments
                    ]
                },
            }
        )
    return drafts


async def _produce_ideation_video_track(
    *,
    pipeline_id: str,
    brief_id: str,
) -> None:
    """Produce N video script drafts. NO voiceover / compose / caption.

    Each draft writes a ``video_creatives`` row via
    ``record_video_stage(stage='script')`` so the row carries a
    ``script_path`` artifact + status='script_ready'. The b-roll-plan
    note rides on the iteration content. After each draft we emit
    ``task_done`` on the pipeline_events timeline.
    """
    brief = _fetch_video_brief(brief_id)
    if brief is None:
        log.warning(
            "pipeline_ideation_video_brief_missing",
            pipeline_id=pipeline_id,
            brief_id=brief_id,
        )
        emit_pipeline_event(
            pipeline_id=pipeline_id,
            kind=EVENT_TASK_ERROR,
            stage="ideation",
            payload={"kind": "video", "error": f"brief not found: {brief_id}"},
        )
        return

    drafts = _fallback_video_drafts(brief, count=IDEATION_VIDEO_DRAFT_COUNT)
    sb = get_supabase_admin()
    queue = get_queue()

    async with queue.acquire(brief_id):
        for draft in drafts:
            concept = str(draft["concept"])
            script = draft["script_outline"]
            broll_plan = draft["broll_plan"]
            emit_pipeline_event(
                pipeline_id=pipeline_id,
                kind=EVENT_TASK_QUEUED,
                stage="ideation",
                payload={"kind": "video", "concept": concept},
            )
            emit_pipeline_event(
                pipeline_id=pipeline_id,
                kind=EVENT_TASK_RUNNING,
                stage="ideation",
                payload={"kind": "video", "concept": concept},
            )
            try:
                # Persist the draft script as a Storage artifact so the
                # Review UI can fetch and display it the same way the
                # post-Generation compose path does.
                storage_path = (
                    f"{brief_id}/ideation-script-{uuid.uuid4().hex[:8]}.json"
                )
                body_json = json.dumps(
                    {"script_outline": script, "broll_plan": broll_plan},
                    indent=2,
                ).encode("utf-8")
                sb.storage.from_(BUCKET).upload(
                    path=storage_path,
                    file=body_json,
                    file_options={
                        "content-type": "application/json",
                        "x-upsert": "true",
                    },
                )
                result = await record_video_stage(
                    brief_id=brief_id,
                    stage="script",
                    paths={"script_path": storage_path},
                    iteration_kind="generate_script",
                    iteration_content={
                        "pipeline_id": pipeline_id,
                        "stage": "ideation",
                        "concept": concept,
                        "script_outline": script,
                        "broll_plan": broll_plan,
                    },
                )
                emit_pipeline_event(
                    pipeline_id=pipeline_id,
                    kind=EVENT_TASK_DONE,
                    stage="ideation",
                    payload={
                        "kind": "video",
                        "concept": concept,
                        "creative_id": result.creative_id,
                        "script_path": storage_path,
                    },
                )
            except Exception as e:  # noqa: BLE001
                log.warning(
                    "pipeline_ideation_video_failed",
                    pipeline_id=pipeline_id,
                    brief_id=brief_id,
                    concept=concept,
                    error=str(e),
                )
                emit_pipeline_event(
                    pipeline_id=pipeline_id,
                    kind=EVENT_TASK_ERROR,
                    stage="ideation",
                    payload={
                        "kind": "video",
                        "concept": concept,
                        "error": str(e),
                    },
                )

    log.info(
        "pipeline_ideation_video_done",
        pipeline_id=pipeline_id,
        brief_id=brief_id,
        drafts=len(drafts),
    )


# ===========================================================================
# PF-E-1 + PF-D-5 — POST /work/pipeline/generation
# ===========================================================================
#
# Generation produces the *final* assets for everything the operator
# picked at Review. We re-use the same external services as
# /work/creative/generate and /work/video/* (Kie.ai, ElevenLabs,
# Submagic, ffmpeg, Hyperframes) rather than re-implementing them.
# Substages within one concept are sequential (script → voiceover →
# broll → compose → caption); across concepts we run in parallel where
# the queue allows.
#
# PF-D-5 idempotency:
#   * If any non-terminal task events exist since the latest
#     stage_advanced→generation event, return ``{ already_running: true }``.
#   * If only terminal events exist, return ``{ already_complete: true }``
#     — auto-advance lands in PF-E-5 so a "stuck at generation" status
#     after every task finished is valid for now.


class GenerationInput(BaseModel):
    """POST body for ``/work/pipeline/generation``."""

    pipeline_id: str = Field(..., min_length=1)


class GenerationAccepted(BaseModel):
    """Response body for ``/work/pipeline/generation``."""

    pipeline_id: str
    accepted: bool = True
    already_running: bool = False
    already_complete: bool = False
    started_at: str | None = None
    image_picks: int = 0
    video_picks: int = 0


@router.post(
    "/work/pipeline/generation", dependencies=[Depends(verify_secret)]
)
async def run_generation(
    body: GenerationInput, background: BackgroundTasks
) -> GenerationAccepted:
    """Fan out the final renders for every pick on this pipeline.

    The producer runs in the background; this route returns 200
    immediately with whichever idempotency outcome applies. The
    background tasks emit ``task_queued`` / ``task_running`` /
    ``task_done`` / ``task_error`` events for every substage so the
    Pipeline detail page can show progress in realtime.
    """
    pipeline = fetch_pipeline(body.pipeline_id)
    if not pipeline:
        raise HTTPException(
            status_code=404, detail=f"pipeline not found: {body.pipeline_id}"
        )

    image_picks, video_picks = picks_from_pipeline(pipeline)

    # Idempotency check — PF-D-5.
    state = generation_state(body.pipeline_id)
    if state.already_running:
        log.info(
            "pipeline_generation_already_running",
            pipeline_id=body.pipeline_id,
            started_at=state.started_at,
        )
        return GenerationAccepted(
            pipeline_id=body.pipeline_id,
            accepted=True,
            already_running=True,
            started_at=state.started_at,
            image_picks=len(image_picks),
            video_picks=len(video_picks),
        )
    if state.already_complete:
        log.info(
            "pipeline_generation_already_complete",
            pipeline_id=body.pipeline_id,
            started_at=state.started_at,
        )
        return GenerationAccepted(
            pipeline_id=body.pipeline_id,
            accepted=True,
            already_complete=True,
            started_at=state.started_at,
            image_picks=len(image_picks),
            video_picks=len(video_picks),
        )

    # Fire the producer for each pick. Image renders are queued
    # per-brief (the SOP forbids parallel kie.ai); video renders fan
    # out per concept. We start a separate background task per concept
    # so a single failure doesn't kill peers.
    if image_picks:
        background.add_task(
            _produce_generation_image_picks,
            pipeline_id=body.pipeline_id,
            creative_ids=image_picks,
        )
    for vid in video_picks:
        background.add_task(
            _produce_generation_video_pick,
            pipeline_id=body.pipeline_id,
            creative_id=vid,
        )

    log.info(
        "pipeline_generation_kicked",
        pipeline_id=body.pipeline_id,
        image_picks=len(image_picks),
        video_picks=len(video_picks),
    )
    return GenerationAccepted(
        pipeline_id=body.pipeline_id,
        accepted=True,
        already_running=False,
        already_complete=False,
        started_at=state.started_at,
        image_picks=len(image_picks),
        video_picks=len(video_picks),
    )


# ---------------------------------------------------------------------------
# Image picks: produce 1:1 + 9:16 finals from each picked ideation
# ---------------------------------------------------------------------------


def _fetch_creative(creative_id: str) -> dict[str, Any] | None:
    """Pull a single ``creatives`` row by id. None if missing."""
    sb = get_supabase_admin()
    resp = (
        sb.table("creatives")
        .select(
            "id, brief_id, concept, offer_text, prompt_used, version, "
            "file_path_supabase"
        )
        .eq("id", creative_id)
        .maybe_single()
        .execute()
    )
    return resp.data if isinstance(resp.data, dict) else None


def _abort_if_cancelled(
    *,
    pipeline_id: str,
    kind: str,
    substage: str | None = None,
    creative_id: str | None = None,
    ratio: str | None = None,
) -> None:
    """Poll ``pipelines.status`` and short-circuit when the operator cancelled.

    Called immediately before each substage entry inside the two generation
    producers. When the pipeline is cancelled we emit ONE ``task_error``
    row tagged ``reason='cancelled_by_operator'`` so the timeline shows
    where the worker stopped — the cancel route itself already wrote the
    ``stage_advanced→cancelled`` row, so we don't duplicate that.

    Raises :class:`PipelineCancelled` which the calling BackgroundTask
    catches at its top level (no other exception handler in the substage
    chain catches it — bare ``except Exception`` blocks in the substage
    loop would otherwise mistake the cancel for a substage failure and
    emit a misleading per-substage error).
    """
    if not pipeline_is_cancelled(pipeline_id):
        return
    payload: dict[str, Any] = {
        "kind": kind,
        "reason": "cancelled_by_operator",
    }
    if substage is not None:
        payload["substage"] = substage
    if creative_id is not None:
        payload["creative_id"] = creative_id
    if ratio is not None:
        payload["ratio"] = ratio
    emit_pipeline_event(
        pipeline_id=pipeline_id,
        kind=EVENT_TASK_ERROR,
        stage="generation",
        payload=payload,
    )
    log.info(
        "pipeline_generation_cancelled",
        pipeline_id=pipeline_id,
        kind=kind,
        substage=substage,
        creative_id=creative_id,
    )
    raise PipelineCancelled()


async def _produce_generation_image_picks(
    *,
    pipeline_id: str,
    creative_ids: list[str],
) -> None:
    """For each picked ideation creative, render 1:1 + 9:16 finals.

    Each pick re-uses the original ideation concept's prompt (read off
    the parent ``prompt_used`` jsonb) and runs Kie.ai twice — one per
    ratio. The two ratios are serialized via the per-brief queue
    because the image SOP forbids parallel kie.ai per brief; renders
    for *different* briefs can interleave.

    Cancellation: between every ratio render we poll ``pipelines.status``
    via :func:`pipeline_is_cancelled` and bail out cleanly when the
    operator cancelled the pipeline from the dashboard. The in-flight
    Kie call (if any) is not interrupted — we can't kill an external
    HTTP call from outside — but no further Kie work is queued.
    """
    try:
        _abort_if_cancelled(pipeline_id=pipeline_id, kind="image")
    except PipelineCancelled:
        return

    try:
        kie_client = KieClient()
    except RuntimeError as e:
        log.warning(
            "pipeline_generation_no_kie_key", pipeline_id=pipeline_id, error=str(e)
        )
        emit_pipeline_event(
            pipeline_id=pipeline_id,
            kind=EVENT_TASK_ERROR,
            stage="generation",
            payload={"kind": "image", "error": str(e)},
        )
        return

    sb = get_supabase_admin()
    queue = get_queue()

    try:
        await _run_generation_image_substages(
            kie_client=kie_client,
            sb=sb,
            queue=queue,
            pipeline_id=pipeline_id,
            creative_ids=creative_ids,
        )
    except PipelineCancelled:
        return


async def _run_generation_image_substages(
    *,
    kie_client: KieClient,
    sb: Any,
    queue: Any,
    pipeline_id: str,
    creative_ids: list[str],
) -> None:
    """Inner loop for image generation, factored out so the
    :class:`PipelineCancelled` short-circuit can unwind the whole nested
    structure (per-creative + per-ratio) with one ``try`` at the caller.
    """
    for creative_id in creative_ids:
        parent = _fetch_creative(creative_id)
        if not parent:
            emit_pipeline_event(
                pipeline_id=pipeline_id,
                kind=EVENT_TASK_ERROR,
                stage="generation",
                payload={
                    "kind": "image",
                    "creative_id": creative_id,
                    "error": "parent creative not found",
                },
            )
            continue

        brief_id = str(parent.get("brief_id") or "")
        concept = str(parent.get("concept") or "concept")
        prompt_used = parent.get("prompt_used") or {}
        prompt_text = (
            prompt_used.get("prompt") if isinstance(prompt_used, dict) else None
        ) or f"Final render of concept {concept}"

        async with queue.acquire(brief_id):
            for ratio in ("1x1", "9x16"):
                _abort_if_cancelled(
                    pipeline_id=pipeline_id,
                    kind="image",
                    creative_id=creative_id,
                    ratio=ratio,
                )
                emit_pipeline_event(
                    pipeline_id=pipeline_id,
                    kind=EVENT_TASK_QUEUED,
                    stage="generation",
                    payload={
                        "kind": "image",
                        "concept": concept,
                        "ratio": ratio,
                        "parent_creative_id": creative_id,
                    },
                )
                running_id = emit_pipeline_event(
                    pipeline_id=pipeline_id,
                    kind=EVENT_TASK_RUNNING,
                    stage="generation",
                    payload={
                        "kind": "image",
                        "concept": concept,
                        "ratio": ratio,
                        "parent_creative_id": creative_id,
                    },
                )
                try:
                    # E4.4 (#506) per-pipeline HARD CAP: refuse BEFORE the paid
                    # render if this ratio's estimated spend plus the pipeline's
                    # already-recorded ACTUAL spend would exceed the cap. Mirrors
                    # the video b-roll submit gate (routes/video.py) so the image
                    # track -- the primary production path -- is bounded across
                    # retries / many-ratio fan-out the same way, and the hard cap
                    # holds regardless of approval mode (it reads the real ledger
                    # the auto-approve path also writes to). On overrun this
                    # raises a 402 caught by the per-ratio handler below as a
                    # task_error, so an over-cap render fails its substage loudly
                    # instead of spending unbounded. The estimate equals the
                    # figure emit_cost records after the spend, so the cap
                    # reserves exactly what the render costs (reserve = pre-flight
                    # read-only check; emit_cost = the actual ledger write -- no
                    # double-count).
                    try:
                        cost_ledger.reserve_budget(
                            pipeline_id, GENERATION_IMAGE_COST_USD
                        )
                    except cost_ledger.BudgetExceeded as exc:
                        raise HTTPException(
                            status_code=402, detail=str(exc)
                        ) from exc
                    result = await kie_client.generate_image_full(
                        prompt_text, ratio, resolution="2K"
                    )
                    storage_path = build_creative_path(
                        brief_id, concept, ratio, "v1.0"
                    )
                    sb.storage.from_(BUCKET).upload(
                        path=storage_path,
                        file=result.image_bytes,
                        file_options={
                            "content-type": "image/png",
                            "x-upsert": "true",
                        },
                    )
                    insert = await record_creative_stage(
                        brief_id=brief_id,
                        file_path_supabase=storage_path,
                        concept=concept,
                        offer_text=parent.get("offer_text"),
                        ratio=ratio,
                        version="v1.0",
                        prompt_used={
                            "model": "kie/nano-banana-2",
                            "prompt": prompt_text,
                            "ratio": ratio,
                            "resolution": "2K",
                            "task_id": result.task_id,
                            "source_url": result.source_url,
                            "stage": "generation",
                            "parent_creative_id": creative_id,
                        },
                        iteration_kind="generate",
                        iteration_content={
                            "prompt": prompt_text,
                            "task_id": result.task_id,
                            "source_url": result.source_url,
                            "pipeline_id": pipeline_id,
                            "stage": "generation",
                        },
                        author="ekko",
                        parent_creative_id=creative_id,
                    )
                    done_id = emit_pipeline_event(
                        pipeline_id=pipeline_id,
                        kind=EVENT_TASK_DONE,
                        stage="generation",
                        payload={
                            "kind": "image",
                            "concept": concept,
                            "ratio": ratio,
                            "creative_id": insert.creative_id,
                            "file_path_supabase": storage_path,
                            "parent_creative_id": creative_id,
                        },
                    )
                    emit_cost(
                        pipeline_id=pipeline_id,
                        api="kie.ai",
                        units=1,
                        # Same constant the reserve gate above checks, so the
                        # recorded ACTUAL matches the pre-flight reservation.
                        subtotal=GENERATION_IMAGE_COST_USD,
                        task_event_id=done_id or running_id,
                        stage="generation",
                        extra={
                            "creative_id": insert.creative_id,
                            "ratio": ratio,
                            "resolution": "2K",
                        },
                    )
                except (KieError, RuntimeError, Exception) as e:  # noqa: BLE001
                    log.warning(
                        "pipeline_generation_image_failed",
                        pipeline_id=pipeline_id,
                        creative_id=creative_id,
                        ratio=ratio,
                        error=str(e),
                    )
                    emit_pipeline_event(
                        pipeline_id=pipeline_id,
                        kind=EVENT_TASK_ERROR,
                        stage="generation",
                        payload={
                            "kind": "image",
                            "concept": concept,
                            "ratio": ratio,
                            "parent_creative_id": creative_id,
                            "error": str(e),
                        },
                    )


# ---------------------------------------------------------------------------
# Video picks: orchestrate the substage chain
# ---------------------------------------------------------------------------


# The substages we run for each picked video concept. Kept as a tuple
# so the order is explicit and grep-able; each entry has an "api" /
# "units" / "subtotal" used by the cost emitter.
_VIDEO_SUBSTAGES: tuple[str, ...] = (
    "script",
    "voiceover",
    "broll_search",
    "broll_pick",
    "compose",
    "caption",
)


def _fetch_video_creative(creative_id: str) -> dict[str, Any] | None:
    """Pull one video_creatives row + its parent brief. None if missing."""
    sb = get_supabase_admin()
    resp = (
        sb.table("video_creatives")
        .select("*, video_briefs(*)")
        .eq("id", creative_id)
        .maybe_single()
        .execute()
    )
    return resp.data if isinstance(resp.data, dict) else None


async def _produce_generation_video_pick(
    *,
    pipeline_id: str,
    creative_id: str,
) -> None:
    """Run the substage chain for one picked video concept.

    For each substage:
      1. Poll ``pipelines.status`` — bail out cleanly on cancel.
      2. Emit ``task_queued`` then ``task_running``.
      3. Call the underlying worker route's helper (delegated to the
         existing video route handlers so we don't re-implement the
         ElevenLabs / yt-dlp / Hyperframes / Submagic plumbing).
      4. Emit ``task_done`` with the resulting path / creative_id, OR
         ``task_error`` if the substage failed.
      5. Emit ``cost_recorded`` after each paid call.

    A substage failure within one concept short-circuits the rest of
    that concept's chain (you can't compose without a voiceover) but
    doesn't affect peer concepts — each peer runs in its own
    background task.

    Cancellation: the cancel poll runs BEFORE each substage's
    ``task_queued`` emit, so a cancelled pipeline mid-chain (e.g. after
    voiceover but before compose) skips the rest with one
    ``task_error(reason='cancelled_by_operator')`` event. The in-flight
    substage (if any) is not killed — we can't interrupt an external
    HTTP call from outside the worker — but no further substages run.

    For the v1 wave we delegate the actual heavy lifting to the
    existing /work/video/* endpoints via direct function calls rather
    than an HTTP round-trip. The route handlers are async, raise
    HTTPException on failure, and write to the same tables we want, so
    catching their exceptions is sufficient error handling here.
    """
    try:
        _abort_if_cancelled(
            pipeline_id=pipeline_id, kind="video", creative_id=creative_id
        )
    except PipelineCancelled:
        return

    creative = _fetch_video_creative(creative_id)
    if not creative:
        emit_pipeline_event(
            pipeline_id=pipeline_id,
            kind=EVENT_TASK_ERROR,
            stage="generation",
            payload={
                "kind": "video",
                "creative_id": creative_id,
                "error": "video creative not found",
            },
        )
        return

    # Lazy import to avoid a circular dep at module load.
    from ..routes import video as video_route  # noqa: PLC0415

    try:
        await _run_generation_video_substages(
            video_route=video_route,
            pipeline_id=pipeline_id,
            creative_id=creative_id,
            creative=creative,
        )
    except PipelineCancelled:
        return


async def _run_generation_video_substages(
    *,
    video_route: Any,
    pipeline_id: str,
    creative_id: str,
    creative: dict[str, Any],
) -> None:
    """Inner per-substage loop for one video concept.

    Factored out of :func:`_produce_generation_video_pick` so the
    cancellation short-circuit unwinds the whole loop with one
    ``except PipelineCancelled`` at the caller — without the bare
    ``except Exception`` per-substage handler accidentally swallowing
    the cancel signal.
    """
    for substage in _VIDEO_SUBSTAGES:
        _abort_if_cancelled(
            pipeline_id=pipeline_id,
            kind="video",
            substage=substage,
            creative_id=creative_id,
        )
        emit_pipeline_event(
            pipeline_id=pipeline_id,
            kind=EVENT_TASK_QUEUED,
            stage="generation",
            payload={
                "kind": "video",
                "substage": substage,
                "creative_id": creative_id,
            },
        )
        running_id = emit_pipeline_event(
            pipeline_id=pipeline_id,
            kind=EVENT_TASK_RUNNING,
            stage="generation",
            payload={
                "kind": "video",
                "substage": substage,
                "creative_id": creative_id,
            },
        )
        try:
            payload = await _run_video_substage(
                video_route, substage=substage, creative=creative
            )
            emit_pipeline_event(
                pipeline_id=pipeline_id,
                kind=EVENT_TASK_DONE,
                stage="generation",
                payload={
                    "kind": "video",
                    "substage": substage,
                    "creative_id": creative_id,
                    **payload,
                },
            )
            cost = _video_substage_cost(substage)
            if cost is not None:
                emit_cost(
                    pipeline_id=pipeline_id,
                    api=cost["api"],
                    units=cost["units"],
                    subtotal=cost["subtotal"],
                    task_event_id=running_id,
                    stage="generation",
                    extra={"creative_id": creative_id, "substage": substage},
                )
        except HTTPException as e:
            log.warning(
                "pipeline_generation_video_substage_failed",
                pipeline_id=pipeline_id,
                creative_id=creative_id,
                substage=substage,
                status=e.status_code,
                error=str(e.detail),
            )
            emit_pipeline_event(
                pipeline_id=pipeline_id,
                kind=EVENT_TASK_ERROR,
                stage="generation",
                payload={
                    "kind": "video",
                    "substage": substage,
                    "creative_id": creative_id,
                    "error": str(e.detail),
                    "status_code": e.status_code,
                },
            )
            # Short-circuit: downstream substages need this one's output.
            return
        except Exception as e:  # noqa: BLE001
            log.warning(
                "pipeline_generation_video_substage_failed",
                pipeline_id=pipeline_id,
                creative_id=creative_id,
                substage=substage,
                error=str(e),
            )
            emit_pipeline_event(
                pipeline_id=pipeline_id,
                kind=EVENT_TASK_ERROR,
                stage="generation",
                payload={
                    "kind": "video",
                    "substage": substage,
                    "creative_id": creative_id,
                    "error": str(e),
                },
            )
            return


async def _run_video_substage(
    video_route: Any,
    *,
    substage: str,
    creative: dict[str, Any],
) -> dict[str, Any]:
    """Dispatch one video substage to the existing /work/video/* handlers.

    Returns the subset of the route's response payload we want to
    surface on the ``task_done`` event (paths + ids — never the raw
    binary bytes).
    """
    creative_id = str(creative["id"])
    brief_id = str(creative.get("brief_id") or "")

    if substage == "script":
        # The script may already exist from ideation. If so, re-confirm
        # and skip the agent call to avoid burning tokens. Otherwise
        # invoke the script route as a fresh call.
        if creative.get("script_path"):
            return {"script_path": creative["script_path"]}
        req = video_route.ScriptRequest(brief_id=brief_id)
        result = await video_route.generate_script(req)
        return {
            "script_path": result.get("script_path"),
            "creative_id": result.get("creative_id"),
        }
    if substage == "voiceover":
        req = video_route.VoiceoverRequest(creative_id=creative_id)
        result = await video_route.synthesize_voiceover(req)
        return {"voiceover_path": result.get("voiceover_path")}
    if substage == "broll_search":
        req = video_route.BrollSearchRequest(creative_id=creative_id)
        result = await video_route.search_broll(req)
        return {"candidates": result.get("candidates")}
    if substage == "broll_pick":
        # Force ``auto`` selection mode for the pipeline generation
        # path — the operator picks at Review *before* generation, so
        # picking again at the brief level would block on UI input.
        req = video_route.BrollSelectRequest(
            creative_id=creative_id, mode="auto"
        )
        result = await video_route.select_broll(req)
        return {"selected": result.get("resolved")}
    if substage == "compose":
        req = video_route.ComposeRequest(creative_id=creative_id)
        result = await video_route.compose_video(req)
        return {"composed_path": result.get("composed_path")}
    if substage == "caption":
        req = video_route.CaptionRequest(creative_id=creative_id)
        result = await video_route.caption_video(req)
        return {"captioned_path": result.get("captioned_path")}
    raise ValueError(f"unknown video substage: {substage!r}")


def _video_substage_cost(substage: str) -> dict[str, Any] | None:
    """Return the cost record for one video substage, or None if free.

    Placeholder figures while PF-F (cost aggregator) is still in
    flight — these get summed into ``pipelines.cost_actual``. Real
    per-tenant pricing replaces these in PF-F.
    """
    # New stack (VID-5): kie ElevenLabs TTS for voiceover; kie video generation
    # is the real spend and now lands in broll_search (clips are generated, not
    # just scraped); compose + caption run on the in-image ffmpeg/Whisper at $0.
    # broll_search's figure is a representative per-ad gen cost (the worker also
    # enforces a hard per-ad budget cap before submit); real per-render pricing
    # replaces these in PF-F.
    table: dict[str, dict[str, Any]] = {
        "voiceover": {"api": "kie-tts", "units": 1, "subtotal": 0.02},
        "broll_search": {"api": "kie-video", "units": 1, "subtotal": 1.20},
        "compose": {"api": "ffmpeg-local", "units": 1, "subtotal": 0.00},
        "caption": {"api": "whisper-local", "units": 1, "subtotal": 0.00},
    }
    return table.get(substage)


__all__ = [
    "router",
    "IDEATION_IMAGE_CONCEPT_COUNT",
    "IDEATION_VIDEO_DRAFT_COUNT",
    "ConfigDraftInput",
    "IdeationInput",
    "IdeationAccepted",
    "GenerationInput",
    "GenerationAccepted",
]
