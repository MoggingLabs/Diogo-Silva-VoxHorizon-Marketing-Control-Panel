"""Operator tool endpoints (Wave A).

A dedicated Hermes **operator** agent runs the existing image-ad pipeline
like a hired employee: it AUTHORS (briefs, concept prompts) and RENDERS
(via these tools), while the manager SUPERVISES in the dashboard and signs
off at gates. These endpoints are the operator's hands — they EXTEND the
mature pipeline in :mod:`worker.src.routes.pipeline`, reusing its services,
event kinds, DB tables and DB triggers rather than duplicating any of it.

Endpoints (all bearer-authed via :func:`verify_secret`):

  GET  /work/pipeline/tools/{pipeline_id}
      Operator READ path. Returns the pipeline row's operator-relevant
      fields plus the authored brief, the ideation concepts, the final
      renders, and the tail of the event timeline so the agent can decide
      what to do next.

  POST /work/pipeline/tools/brief
      Operator AUTHORS the image brief (idempotent upsert). NOT spend-gated
      — the manager reviews the brief via the existing stage gate.

  POST /work/pipeline/tools/render
      Operator RENDERS — THE spend tool, gated by the approval plugin
      (not by this endpoint). A SYNCHRONOUS batch render of operator-
      authored prompts that mirrors the canonical render loop in
      ``pipeline.py`` EXACTLY (queue.acquire → emit task events → Kie →
      Storage upload → record_creative_stage → emit_cost). Returns once
      every item has resolved so the operator can narrate the results.

  POST /work/pipeline/tools/dispatch
      Server-side helper the dashboard calls to KICK the operator (NOT
      called by the operator itself). Fire-and-forget ``hermes chat`` into
      the operator container; returns immediately.

Render parameters per the pipeline SOP (kept identical to the existing
producers so the two paths emit indistinguishable creatives):

  * concept_preview → ratios=["1x1"], resolution="1K",  version="v0.ideation", stage="ideation"
  * final          → ratios=["1x1","9x16"], resolution="2K", version="v1.0",  stage="generation"

Authorship note: the existing ``record_creative_stage`` writes
``creative_iterations.author`` which is constrained by the ``iteration_author``
DB enum (``'user' | 'ekko'`` — see migration 0001; never extended). The
operator is a Hermes agent in the same family as Ekko, so we pass
``author="ekko"`` to satisfy the enum and stamp ``"author": "operator"``
into the free-form ``prompt_used`` / ``iteration_content`` jsonb so the
operator's authorship stays traceable without a schema change.
"""

from __future__ import annotations

from typing import Any, Literal

import structlog
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from pydantic import BaseModel, Field

from ..auth import verify_secret
from ..services.atomic_inserts import record_creative_stage
from ..services.kie import KieClient, KieError
from ..services.operator_bridge import OperatorBridgeError, get_operator_bridge
from ..services.pipeline_runner import (
    EVENT_TASK_DONE,
    EVENT_TASK_ERROR,
    EVENT_TASK_QUEUED,
    EVENT_TASK_RUNNING,
    emit_cost,
    emit_pipeline_event,
    fetch_pipeline,
)
from ..services.queue import get_queue
from ..services.storage import BUCKET, build_creative_path
from ..supabase_client import get_supabase_admin


log = structlog.get_logger(__name__)


router = APIRouter()


# How many trailing pipeline_events the read tool returns so the operator
# can reason about recent progress without pulling the whole timeline.
EVENTS_TAIL_LIMIT = 20

# Per-kind render parameters. Single source of truth so the render loop and
# any future caller stay in lockstep with the existing producers' SOP.
_CONCEPT_PREVIEW = {
    "ratios": ("1x1",),
    "resolution": "1K",
    "version": "v0.ideation",
    "stage": "ideation",
    "cost_usd": 0.02,
}
_FINAL = {
    "ratios": ("1x1", "9x16"),
    "resolution": "2K",
    "version": "v1.0",
    "stage": "generation",
    "cost_usd": 0.05,
}


# ---------------------------------------------------------------------------
# GET /work/pipeline/tools/{pipeline_id}
# ---------------------------------------------------------------------------


def _fetch_brief_for_read(brief_id: str) -> dict[str, Any] | None:
    """Pull the (id, payload) of the image brief, or None if missing."""
    sb = get_supabase_admin()
    resp = (
        sb.table("briefs")
        .select("id, payload")
        .eq("id", brief_id)
        .maybe_single()
        .execute()
    )
    return resp.data if isinstance(resp.data, dict) else None


def _fetch_brief_creatives(brief_id: str) -> list[dict[str, Any]]:
    """Pull every creative for a brief (operator-relevant columns only).

    We partition into concepts (``v0.ideation``) and finals (``v1*``) in
    Python rather than issuing two filtered selects: the version split is a
    prefix match that the supabase-py ``like`` filter expresses awkwardly,
    and pipeline briefs hold only a handful of creatives, so one read is
    cheaper than two round-trips.
    """
    sb = get_supabase_admin()
    resp = (
        sb.table("creatives")
        .select("id, concept, ratio, version, file_path_supabase")
        .eq("brief_id", brief_id)
        .execute()
    )
    rows = resp.data
    return list(rows) if isinstance(rows, list) else []


def _fetch_events_tail(pipeline_id: str, *, limit: int) -> list[dict[str, Any]]:
    """Return the most recent ``limit`` events oldest-first for narration."""
    sb = get_supabase_admin()
    resp = (
        sb.table("pipeline_events")
        .select("id, kind, stage, payload, created_at")
        .eq("pipeline_id", pipeline_id)
        .order("created_at", desc=True)
        .limit(limit)
        .execute()
    )
    rows = resp.data if isinstance(resp.data, list) else []
    # Newest-first off the index, then reverse so the operator reads the
    # tail in chronological order.
    return list(reversed(rows))


def _creative_view(row: dict[str, Any]) -> dict[str, Any]:
    """Project a creatives row down to the operator-facing shape."""
    return {
        "creative_id": row.get("id"),
        "concept": row.get("concept"),
        "ratio": row.get("ratio"),
        "version": row.get("version"),
        "file_path_supabase": row.get("file_path_supabase"),
    }


@router.get(
    "/work/pipeline/tools/{pipeline_id}", dependencies=[Depends(verify_secret)]
)
async def read_pipeline_tools(pipeline_id: str) -> dict[str, Any]:
    """Operator read path: pipeline state + brief + creatives + event tail."""
    pipeline = fetch_pipeline(pipeline_id)
    if not pipeline:
        raise HTTPException(
            status_code=404, detail=f"pipeline not found: {pipeline_id}"
        )

    brief_id = pipeline.get("image_brief_id")
    brief: dict[str, Any] | None = None
    concepts: list[dict[str, Any]] = []
    finals: list[dict[str, Any]] = []
    if brief_id:
        brief_row = _fetch_brief_for_read(str(brief_id))
        if brief_row is not None:
            brief = {"id": brief_row.get("id"), "payload": brief_row.get("payload")}
        for row in _fetch_brief_creatives(str(brief_id)):
            version = str(row.get("version") or "")
            view = _creative_view(row)
            if version == "v0.ideation":
                concepts.append(view)
            elif version.startswith("v1"):
                finals.append(view)

    return {
        "pipeline_id": pipeline.get("id"),
        "status": pipeline.get("status"),
        "format_choice": pipeline.get("format_choice"),
        "config_draft": pipeline.get("config_draft"),
        "picks": pipeline.get("picks"),
        "brief": brief,
        "concepts": concepts,
        "finals": finals,
        "events_tail": _fetch_events_tail(pipeline_id, limit=EVENTS_TAIL_LIMIT),
    }


# ---------------------------------------------------------------------------
# POST /work/pipeline/tools/brief
# ---------------------------------------------------------------------------


class BriefImagePayload(BaseModel):
    """Operator-authored image brief payload.

    ``market`` / ``offer_text`` / ``angles`` are the required creative
    inputs the operator must supply; everything else is optional and passed
    through verbatim (``model_config`` allows extra keys so the operator can
    enrich the payload without a schema bump).
    """

    model_config = {"extra": "allow"}

    market: str = Field(..., min_length=1)
    offer_text: str = Field(..., min_length=1)
    angles: list[str] = Field(..., min_length=1)
    audience: str | None = None
    service_type: str | None = None


class BriefInput(BaseModel):
    """POST body for ``/work/pipeline/tools/brief``."""

    pipeline_id: str = Field(..., min_length=1)
    image_payload: BriefImagePayload
    notes: str | None = None


# The briefs.payload CHECK constraint (migration 0001) requires the keys
# `service` and `budget`. The operator authors market/offer_text/angles, so
# we backfill these two so the row satisfies the constraint without forcing
# the operator to think about plumbing it doesn't own. The manager refines
# real budget/service at the stage gate.
_BRIEF_PAYLOAD_DEFAULTS: dict[str, Any] = {
    "service": "roofing",
    "budget": 0,
}


def _client_slug(pipeline: dict[str, Any]) -> str:
    """Resolve a client slug for ``gen_brief_id_human``; fall back gracefully."""
    sb = get_supabase_admin()
    client_id = pipeline.get("client_id")
    if not client_id:
        return "pipeline"
    try:
        resp = (
            sb.table("clients")
            .select("slug")
            .eq("id", str(client_id))
            .maybe_single()
            .execute()
        )
    except Exception:  # noqa: BLE001 — slug is best-effort, not load-bearing
        return "pipeline"
    row = resp.data
    if isinstance(row, dict) and row.get("slug"):
        return str(row["slug"])
    return "pipeline"


def _gen_brief_id_human(slug: str) -> str:
    """Mint a human brief id via the DB helper, with a uuid fallback.

    ``briefs.brief_id_human`` is UNIQUE NOT NULL; the canonical generator is
    the ``gen_brief_id_human(slug)`` SQL function (migration 0001). If the
    RPC is unavailable we fall back to a slug + random suffix so the insert
    still succeeds.
    """
    sb = get_supabase_admin()
    try:
        resp = sb.rpc("gen_brief_id_human", {"p_client_slug": slug}).execute()
        value = resp.data
        if isinstance(value, str) and value:
            return value
    except Exception:  # noqa: BLE001 — fall through to the local fallback
        pass
    import uuid

    return f"{slug}-{uuid.uuid4().hex[:8]}"


@router.post("/work/pipeline/tools/brief", dependencies=[Depends(verify_secret)])
async def author_brief(body: BriefInput) -> dict[str, Any]:
    """Author (or update) the pipeline's image brief.

    Idempotent: if the pipeline already points at an image brief we UPDATE
    that row's payload; otherwise we INSERT a fresh ``briefs`` row and link
    it via ``pipelines.image_brief_id``. Either way we merge the authored
    payload + notes into ``config_draft`` and emit a ``brief_authored``
    event so the manager's supervision view updates.
    """
    pipeline = fetch_pipeline(body.pipeline_id)
    if not pipeline:
        raise HTTPException(
            status_code=404, detail=f"pipeline not found: {body.pipeline_id}"
        )

    sb = get_supabase_admin()
    authored = body.image_payload.model_dump(exclude_none=True)
    payload = {**_BRIEF_PAYLOAD_DEFAULTS, **authored}
    # The briefs CHECK only requires a `service` key to exist, but honour the
    # operator's authored service so a non-roofing campaign isn't mislabelled
    # by the default. The manager still refines budget/service at the gate.
    if authored.get("service_type"):
        payload["service"] = authored["service_type"]
    existing_brief_id = pipeline.get("image_brief_id")

    if existing_brief_id:
        # Idempotent re-author: update the linked brief's payload in place.
        sb.table("briefs").update({"payload": payload}).eq(
            "id", str(existing_brief_id)
        ).execute()
        brief_id = str(existing_brief_id)
    else:
        slug = _client_slug(pipeline)
        insert_row: dict[str, Any] = {
            "brief_id_human": _gen_brief_id_human(slug),
            "client_id": pipeline.get("client_id"),
            "status": "draft",
            "payload": payload,
        }
        created = sb.table("briefs").insert(insert_row).execute().data
        brief_id = str(created[0]["id"])

    # Merge the authored material into config_draft (preserving anything the
    # configuration interview already stored) and link the brief.
    config_draft = pipeline.get("config_draft")
    if not isinstance(config_draft, dict):
        config_draft = {}
    merged_draft = {
        **config_draft,
        "image_payload": payload,
        "notes": body.notes,
    }
    sb.table("pipelines").update(
        {"image_brief_id": brief_id, "config_draft": merged_draft}
    ).eq("id", body.pipeline_id).execute()

    emit_pipeline_event(
        pipeline_id=body.pipeline_id,
        kind="brief_authored",
        stage="configuration",
        payload={"brief_id": brief_id, "notes": body.notes},
    )

    log.info(
        "operator_brief_authored",
        pipeline_id=body.pipeline_id,
        brief_id=brief_id,
        updated=bool(existing_brief_id),
    )
    return {"ok": True, "brief_id": brief_id}


# ---------------------------------------------------------------------------
# POST /work/pipeline/tools/render
# ---------------------------------------------------------------------------


class RenderItem(BaseModel):
    """One operator-authored render request."""

    concept: str = Field(..., min_length=1)
    prompt: str = Field(..., min_length=1)
    offer_text: str | None = None
    parent_creative_id: str | None = None


class RenderInput(BaseModel):
    """POST body for ``/work/pipeline/tools/render``."""

    pipeline_id: str = Field(..., min_length=1)
    kind: Literal["concept_preview", "final"]
    items: list[RenderItem] = Field(..., min_length=1)


async def _render_one(
    *,
    kie_client: Any,
    sb: Any,
    pipeline_id: str,
    brief_id: str,
    item: RenderItem,
    ratio: str,
    params: dict[str, Any],
) -> dict[str, Any]:
    """Run the canonical render pattern for one item × ratio.

    Mirrors ``_run_generation_image_substages`` exactly: emit task_queued →
    task_running, call Kie, upload to Storage, record the creative, emit
    task_done + cost_recorded. Returns the render descriptor. Raises on any
    Kie/storage/insert failure so the caller can record a task_error and
    continue with the rest of the batch.
    """
    resolution = str(params["resolution"])
    version = str(params["version"])
    stage = params["stage"]
    cost_usd = float(params["cost_usd"])

    base_payload: dict[str, Any] = {
        "kind": "image",
        "concept": item.concept,
        "ratio": ratio,
    }
    if item.parent_creative_id:
        base_payload["parent_creative_id"] = item.parent_creative_id

    emit_pipeline_event(
        pipeline_id=pipeline_id,
        kind=EVENT_TASK_QUEUED,
        stage=stage,
        payload=base_payload,
    )
    running_id = emit_pipeline_event(
        pipeline_id=pipeline_id,
        kind=EVENT_TASK_RUNNING,
        stage=stage,
        payload=base_payload,
    )

    result = await kie_client.generate_image_full(
        item.prompt, ratio, resolution=resolution
    )
    storage_path = build_creative_path(brief_id, item.concept, ratio, version)
    sb.storage.from_(BUCKET).upload(
        path=storage_path,
        file=result.image_bytes,
        file_options={"content-type": "image/png", "x-upsert": "true"},
    )
    insert = await record_creative_stage(
        brief_id=brief_id,
        file_path_supabase=storage_path,
        concept=item.concept,
        offer_text=item.offer_text,
        ratio=ratio,
        version=version,
        prompt_used={
            "model": "kie/nano-banana-2",
            "prompt": item.prompt,
            "ratio": ratio,
            "resolution": resolution,
            "task_id": result.task_id,
            "source_url": result.source_url,
            "stage": stage,
            # Operator authorship marker (the DB enum can't store it on the
            # author column — see module docstring).
            "author": "operator",
            **(
                {"parent_creative_id": item.parent_creative_id}
                if item.parent_creative_id
                else {}
            ),
        },
        iteration_kind="generate",
        iteration_content={
            "prompt": item.prompt,
            "task_id": result.task_id,
            "source_url": result.source_url,
            "pipeline_id": pipeline_id,
            "stage": stage,
            "author": "operator",
        },
        # The iteration_author enum is ('user','ekko'); the operator is a
        # Hermes agent in the Ekko family, so we reuse 'ekko' here.
        author="ekko",
        parent_creative_id=item.parent_creative_id,
    )

    done_payload = {
        **base_payload,
        "creative_id": insert.creative_id,
        "file_path_supabase": storage_path,
    }
    done_id = emit_pipeline_event(
        pipeline_id=pipeline_id,
        kind=EVENT_TASK_DONE,
        stage=stage,
        payload=done_payload,
    )
    emit_cost(
        pipeline_id=pipeline_id,
        api="kie.ai",
        units=1,
        subtotal=cost_usd,
        task_event_id=done_id or running_id,
        stage=stage,
        extra={
            "creative_id": insert.creative_id,
            "ratio": ratio,
            "resolution": resolution,
        },
    )
    return {
        "creative_id": insert.creative_id,
        "concept": item.concept,
        "ratio": ratio,
        "file_path_supabase": storage_path,
        "cost_usd": cost_usd,
    }


@router.post("/work/pipeline/tools/render", dependencies=[Depends(verify_secret)])
async def render(body: RenderInput) -> dict[str, Any]:
    """Synchronously render a batch of operator-authored prompts.

    THE spend tool — the approval plugin intercepts this call to long-poll
    the manager for spend approval; this endpoint itself is not gated. Each
    item × ratio runs the canonical render loop, serialized per brief via
    the existing ``BriefQueue`` (the SOP forbids parallel Kie within one
    brief). Per-item failures emit a ``task_error`` and continue so one bad
    render doesn't abort the batch.
    """
    pipeline = fetch_pipeline(body.pipeline_id)
    if not pipeline:
        raise HTTPException(
            status_code=404, detail=f"pipeline not found: {body.pipeline_id}"
        )

    brief_id = pipeline.get("image_brief_id")
    if not brief_id:
        raise HTTPException(
            status_code=400,
            detail="pipeline has no image_brief_id; author a brief first",
        )
    brief_id = str(brief_id)

    params = _CONCEPT_PREVIEW if body.kind == "concept_preview" else _FINAL
    stage = params["stage"]

    if body.kind == "final":
        missing = [it.concept for it in body.items if not it.parent_creative_id]
        if missing:
            raise HTTPException(
                status_code=400,
                detail=(
                    "final renders require parent_creative_id per item; "
                    f"missing for: {missing}"
                ),
            )

    try:
        kie_client = KieClient()
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e)) from e

    sb = get_supabase_admin()
    queue = get_queue()

    renders: list[dict[str, Any]] = []
    errors: list[dict[str, Any]] = []
    total_cost_usd = 0.0

    # Serialize all Kie work for this brief behind the per-brief lock, same
    # as the existing producers. Different briefs can still interleave.
    async with queue.acquire(brief_id):
        for item in body.items:
            for ratio in params["ratios"]:
                try:
                    descriptor = await _render_one(
                        kie_client=kie_client,
                        sb=sb,
                        pipeline_id=body.pipeline_id,
                        brief_id=brief_id,
                        item=item,
                        ratio=ratio,
                        params=params,
                    )
                    renders.append(descriptor)
                    total_cost_usd += float(descriptor["cost_usd"])
                except (KieError, RuntimeError, Exception) as e:  # noqa: BLE001
                    log.warning(
                        "operator_render_item_failed",
                        pipeline_id=body.pipeline_id,
                        brief_id=brief_id,
                        concept=item.concept,
                        ratio=ratio,
                        error=str(e),
                    )
                    err_payload = {
                        "kind": "image",
                        "concept": item.concept,
                        "ratio": ratio,
                        "error": str(e),
                    }
                    if item.parent_creative_id:
                        err_payload["parent_creative_id"] = item.parent_creative_id
                    emit_pipeline_event(
                        pipeline_id=body.pipeline_id,
                        kind=EVENT_TASK_ERROR,
                        stage=stage,
                        payload=err_payload,
                    )
                    errors.append(
                        {
                            "concept": item.concept,
                            "ratio": ratio,
                            "error": str(e),
                        }
                    )

    log.info(
        "operator_render_done",
        pipeline_id=body.pipeline_id,
        kind=body.kind,
        rendered=len(renders),
        errors=len(errors),
        total_cost_usd=total_cost_usd,
    )
    return {
        "ok": True,
        "renders": renders,
        "total_cost_usd": round(total_cost_usd, 4),
        "errors": errors,
    }


# ---------------------------------------------------------------------------
# POST /work/pipeline/tools/dispatch
# ---------------------------------------------------------------------------


class DispatchInput(BaseModel):
    """POST body for ``/work/pipeline/tools/dispatch``."""

    pipeline_id: str = Field(..., min_length=1)
    instruction: str = Field(..., min_length=1)


@router.post(
    "/work/pipeline/tools/dispatch", dependencies=[Depends(verify_secret)]
)
async def dispatch_operator(
    body: DispatchInput, background: BackgroundTasks
) -> dict[str, Any]:
    """Fire-and-forget kick the operator agent for a pipeline.

    Called by the dashboard's Next.js routes (not by the operator) to
    re-task the operator after a manager stage-gate action. The pipeline id
    is passed as the operator's session id so its playbook can re-load
    state. We schedule the docker-exec on a ``BackgroundTask`` and return
    immediately — the caller never sees the operator's stdout.
    """
    bridge = get_operator_bridge()
    background.add_task(
        _dispatch_in_background,
        bridge=bridge,
        instruction=body.instruction,
        session_id=body.pipeline_id,
    )
    log.info(
        "operator_dispatch_scheduled",
        pipeline_id=body.pipeline_id,
        instruction_chars=len(body.instruction),
    )
    return {"ok": True, "dispatched": True}


async def _dispatch_in_background(
    *, bridge: Any, instruction: str, session_id: str
) -> None:
    """Run the operator dispatch, swallowing bridge errors with a log.

    The HTTP response has already returned ``dispatched: true`` by the time
    this runs, so a docker failure can't be surfaced to the caller — log it
    instead. The dashboard observes real operator progress (or its absence)
    through ``pipeline_events`` / Realtime.
    """
    try:
        await bridge.dispatch(instruction, session_id)
    except OperatorBridgeError as e:
        log.warning(
            "operator_dispatch_failed",
            session_id=session_id,
            error=str(e),
        )


__all__ = [
    "router",
    "BriefInput",
    "BriefImagePayload",
    "RenderInput",
    "RenderItem",
    "DispatchInput",
    "EVENTS_TAIL_LIMIT",
]
