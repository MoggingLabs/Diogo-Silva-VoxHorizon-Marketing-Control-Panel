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
      what to do next. When the pipeline is linked to a client, a compact
      ``client`` block (name, service_type, offers, offer_constraints, tone,
      a few USPs, plus the structured ``targeting`` block) rides along so the
      operator gets brand + offers + do-not-say + the targeted area on the
      first read; the FULL profile stays behind ``/work/client/{id}``.

  GET  /work/client/{client_id}
      Operator CLIENT-CONTEXT path. Returns the client's brand / company /
      campaign knowledge (identity, the typed ``client_profiles`` row, the
      offers, the do-not-say constraints, services, value props, assets and
      past projects) so the operator can author on-brand, compliant ads.
      Read-only; no spend.

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

import base64
import binascii
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
    PipelineStage,
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

# Per-kind storage parameters for the codex-backed /store_creative path. The
# operator renders the bytes IN ITS OWN CONTAINER via Hermes' codex image
# provider (the manager's ChatGPT/Codex OAuth — $0), so the worker just stores
# them and records a zero-cost line. Stage/version mirror the Kie /render path
# exactly so the two backends produce indistinguishable creatives, events and
# auto-advance behaviour; only the cost (0) and the cost `api` differ.
_STORE_STAGE: dict[str, PipelineStage] = {
    "concept_preview": "ideation",
    "final": "generation",
}
# Cost ``api`` label for the subscription-backed render. The operator pays
# nothing (the image is generated on the manager's ChatGPT/Codex subscription),
# so every stored creative records subtotal=0 against this api.
_CODEX_COST_API = "openai-codex"


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
    # maybe_single().execute() returns None (not a response) when the brief is
    # absent — guard it so the read tool degrades to "no brief" cleanly.
    return resp.data if (resp is not None and isinstance(resp.data, dict)) else None


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

    # When the pipeline is linked to a client, surface a COMPACT client block
    # so the operator gets brand voice + the real offers + the do-not-say rules
    # on its very first read (no second round-trip needed for the common case).
    # The FULL typed profile + assets + past projects stay behind
    # /work/client/{id} so this read response stays small.
    client_compact: dict[str, Any] | None = None
    client_id = pipeline.get("client_id")
    if client_id:
        client_compact = _fetch_client_compact(str(client_id))

    return {
        "pipeline_id": pipeline.get("id"),
        "status": pipeline.get("status"),
        "format_choice": pipeline.get("format_choice"),
        "config_draft": pipeline.get("config_draft"),
        "picks": pipeline.get("picks"),
        "brief": brief,
        "concepts": concepts,
        "finals": finals,
        "client": client_compact,
        "events_tail": _fetch_events_tail(pipeline_id, limit=EVENTS_TAIL_LIMIT),
    }


# ---------------------------------------------------------------------------
# GET /work/client/{client_id}  — operator client context
# ---------------------------------------------------------------------------
#
# The dashboard operator authors ads from the per-client brand / company /
# campaign knowledge that migration 0012 normalized into Supabase
# (``clients`` + ``client_profiles`` + the child tables). The operator reaches
# the DB only through the worker, so these read helpers mirror
# :func:`_fetch_brief_for_read` exactly: ``get_supabase_admin()`` →
# ``select(...).eq(...).maybe_single()/execute()`` with the
# ``resp.data if resp is not None`` None-guard for the maybe_single reads.

# How many USPs the COMPACT block (on the pipeline read) carries, so the
# operator gets the top differentiators without the full value-prop list.
_COMPACT_USP_LIMIT = 3


def _targeting_block(profile: dict[str, Any] | None) -> dict[str, Any] | None:
    """Project the structured geo-targeting (migration 0013) into a clean block.

    Returns ``{address, zip, radius_miles, type, description}`` where
    ``description`` is the existing free-text ``targeting`` prose. Returns None
    when the profile is missing so the route can fold it into the response as
    ``targeting: null`` rather than emit an all-null object. Individual keys
    stay None when the underlying gap is unfilled (tracked in needs_input).
    """
    if not isinstance(profile, dict):
        return None
    return {
        "address": profile.get("targeting_address"),
        "zip": profile.get("targeting_zip"),
        "radius_miles": profile.get("targeting_radius_miles"),
        "type": profile.get("targeting_type"),
        "description": profile.get("targeting"),
    }


def _fetch_client_row(client_id: str) -> dict[str, Any] | None:
    """Pull the identity columns off ``clients``, or None if missing.

    maybe_single().execute() returns None (not a response) when the row is
    absent — guard it so the route can 404 cleanly rather than raising.
    """
    sb = get_supabase_admin()
    resp = (
        sb.table("clients")
        .select("id, slug, name, service_type, brand_colors")
        .eq("id", client_id)
        .maybe_single()
        .execute()
    )
    return resp.data if (resp is not None and isinstance(resp.data, dict)) else None


def _fetch_client_profile(client_id: str) -> dict[str, Any] | None:
    """Pull the 1:1 ``client_profiles`` row, or None when unfilled.

    The whole typed row is returned verbatim (``select("*")``) so the operator
    can reason over every fact (years_in_business, google_rating, warranty,
    targeting, …) without the worker having to enumerate ~70 columns.
    """
    sb = get_supabase_admin()
    resp = (
        sb.table("client_profiles")
        .select("*")
        .eq("client_id", client_id)
        .maybe_single()
        .execute()
    )
    return resp.data if (resp is not None and isinstance(resp.data, dict)) else None


def _fetch_client_offers(client_id: str) -> list[dict[str, Any]]:
    """Return the client's offers (offer_text + active), source order."""
    sb = get_supabase_admin()
    resp = (
        sb.table("client_offers")
        .select("offer_text, active, sort_order")
        .eq("client_id", client_id)
        .order("sort_order", desc=False)
        .execute()
    )
    rows = resp.data if (resp is not None and isinstance(resp.data, list)) else []
    return [
        {"offer_text": r.get("offer_text"), "active": r.get("active")}
        for r in rows
    ]


def _fetch_client_offer_constraints(client_id: str) -> list[str]:
    """Return the do-not-say constraint texts, source order.

    These are the CRITICAL compliance rules — the operator must never author
    copy that violates them.
    """
    sb = get_supabase_admin()
    resp = (
        sb.table("client_offer_constraints")
        .select("constraint_text, sort_order")
        .eq("client_id", client_id)
        .order("sort_order", desc=False)
        .execute()
    )
    rows = resp.data if (resp is not None and isinstance(resp.data, list)) else []
    return [r["constraint_text"] for r in rows if r.get("constraint_text")]


def _fetch_client_services(client_id: str) -> list[str]:
    """Return the client's service names, source order."""
    sb = get_supabase_admin()
    resp = (
        sb.table("client_services")
        .select("service_name, sort_order")
        .eq("client_id", client_id)
        .order("sort_order", desc=False)
        .execute()
    )
    rows = resp.data if (resp is not None and isinstance(resp.data, list)) else []
    return [r["service_name"] for r in rows if r.get("service_name")]


def _fetch_client_value_props(client_id: str) -> dict[str, list[str]]:
    """Return value props split into ``usps`` / ``differentiators``.

    The ``client_value_props.kind`` enum is ``usp | differentiator``; we
    bucket in Python (one read) rather than two filtered selects.
    """
    sb = get_supabase_admin()
    resp = (
        sb.table("client_value_props")
        .select("kind, prop_text, sort_order")
        .eq("client_id", client_id)
        .order("sort_order", desc=False)
        .execute()
    )
    rows = resp.data if (resp is not None and isinstance(resp.data, list)) else []
    usps: list[str] = []
    differentiators: list[str] = []
    for r in rows:
        text = r.get("prop_text")
        if not text:
            continue
        if r.get("kind") == "usp":
            usps.append(text)
        elif r.get("kind") == "differentiator":
            differentiators.append(text)
    return {"usps": usps, "differentiators": differentiators}


def _fetch_client_assets(client_id: str) -> list[dict[str, Any]]:
    """Return the client's assets (kind, source, ref, formats, label)."""
    sb = get_supabase_admin()
    resp = (
        sb.table("client_assets")
        .select("kind, source, ref, formats, label, sort_order")
        .eq("client_id", client_id)
        .order("sort_order", desc=False)
        .execute()
    )
    rows = resp.data if (resp is not None and isinstance(resp.data, list)) else []
    return [
        {
            "kind": r.get("kind"),
            "source": r.get("source"),
            "ref": r.get("ref"),
            "formats": r.get("formats"),
            "label": r.get("label"),
        }
        for r in rows
    ]


def _fetch_client_past_projects(client_id: str) -> list[str]:
    """Return the client's past-project URLs, source order."""
    sb = get_supabase_admin()
    resp = (
        sb.table("client_past_projects")
        .select("url, sort_order")
        .eq("client_id", client_id)
        .order("sort_order", desc=False)
        .execute()
    )
    rows = resp.data if (resp is not None and isinstance(resp.data, list)) else []
    return [r["url"] for r in rows if r.get("url")]


def _fetch_client_compact(client_id: str) -> dict[str, Any] | None:
    """Build the COMPACT client block carried on the pipeline read.

    Returns the minimum the operator needs to start authoring on-brand and
    compliant on its FIRST read: the name, the service type, the REAL offers,
    the do-not-say constraints, the brand tone, and the top few USPs. Returns
    None when the client row is missing so the read tool degrades cleanly to
    ``client: null``. The FULL profile stays behind /work/client/{id}.
    """
    client_row = _fetch_client_row(client_id)
    if client_row is None:
        return None
    profile = _fetch_client_profile(client_id)
    tone = profile.get("tone") if isinstance(profile, dict) else None
    value_props = _fetch_client_value_props(client_id)
    return {
        "client_id": client_id,
        "name": client_row.get("name"),
        "service_type": client_row.get("service_type"),
        "tone": tone,
        "offers": _fetch_client_offers(client_id),
        "offer_constraints": _fetch_client_offer_constraints(client_id),
        "top_usps": value_props["usps"][:_COMPACT_USP_LIMIT],
        # Structured geo-targeting so the operator can frame the ad's setting to
        # the targeted area (zip + radius reach) on its first read.
        "targeting": _targeting_block(profile),
    }


@router.get("/work/client/{client_id}", dependencies=[Depends(verify_secret)])
async def read_client(client_id: str) -> dict[str, Any]:
    """Operator client-context path: brand + company + offers + constraints.

    Returns the full per-client knowledge the operator authors ads from. The
    client row is required (404 when missing, mirroring the pipeline-not-found
    pattern); the typed ``client_profiles`` row degrades to ``profile: null``
    when unfilled, and every child collection degrades to an empty list. Pure
    read — no spend, no side effects.
    """
    client_row = _fetch_client_row(client_id)
    if client_row is None:
        raise HTTPException(
            status_code=404, detail=f"client not found: {client_id}"
        )

    profile = _fetch_client_profile(client_id)
    return {
        "client_id": client_row.get("id"),
        "slug": client_row.get("slug"),
        "name": client_row.get("name"),
        "service_type": client_row.get("service_type"),
        "brand_colors": client_row.get("brand_colors"),
        "profile": profile,
        # Clean structured geo-targeting block ({address, zip, radius_miles,
        # type, description}); the full typed values also live on `profile`.
        "targeting": _targeting_block(profile),
        "offers": _fetch_client_offers(client_id),
        "offer_constraints": _fetch_client_offer_constraints(client_id),
        "services": _fetch_client_services(client_id),
        "value_props": _fetch_client_value_props(client_id),
        "assets": _fetch_client_assets(client_id),
        "past_projects": _fetch_client_past_projects(client_id),
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


class ConceptSpec(BaseModel):
    """One persisted concept spec authored at brief time.

    The operator authors all N concepts up front (with the
    ``image-ad-authoring`` skill) and persists them here so the ideation render
    can be a single DETERMINISTIC, worker-driven pass over the stored specs —
    the LLM never holds the prompts through a long synchronous render, and a
    retried render resumes from the persisted plan instead of re-authoring.

    Shape mirrors an ``image-ad-authoring`` ``build_concept`` result
    (``{concept, prompt, offer_text?}``); extra keys are allowed so the author
    can enrich a concept without a schema bump.
    """

    model_config = {"extra": "allow"}

    concept: str = Field(..., min_length=1)
    prompt: str = Field(..., min_length=1)
    offer_text: str | None = None


class BriefInput(BaseModel):
    """POST body for ``/work/pipeline/tools/brief``."""

    pipeline_id: str = Field(..., min_length=1)
    image_payload: BriefImagePayload
    notes: str | None = None
    # The full N concept specs, persisted so ``/render`` (and the operator's
    # codex render) can run ALL concepts deterministically in one pass without
    # the operator re-supplying them per call. Optional for back-compat: a brief
    # may be authored before the concepts exist; the render then falls back to
    # whatever ``items`` the caller supplies.
    concepts: list[ConceptSpec] | None = None


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
    row = resp.data if resp is not None else None
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
    # Persist the full concept specs (when supplied) on the brief payload so the
    # deterministic ideation render can fan out over them with no LLM in the
    # loop. Stored under a dedicated `concepts` key so it never collides with
    # the required market/offer_text/angles keys.
    concept_specs: list[dict[str, Any]] = (
        [c.model_dump(exclude_none=True) for c in body.concepts]
        if body.concepts
        else []
    )
    if concept_specs:
        payload["concepts"] = concept_specs
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
    # Mirror the concept plan onto config_draft so the operator read surfaces it
    # directly (the read returns config_draft) for the deterministic render.
    if concept_specs:
        merged_draft["concepts"] = concept_specs
    sb.table("pipelines").update(
        {"image_brief_id": brief_id, "config_draft": merged_draft}
    ).eq("id", body.pipeline_id).execute()

    emit_pipeline_event(
        pipeline_id=body.pipeline_id,
        kind="brief_authored",
        stage="configuration",
        payload={
            "brief_id": brief_id,
            "notes": body.notes,
            "concept_count": len(concept_specs),
        },
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
    """POST body for ``/work/pipeline/tools/render``.

    ``items`` is OPTIONAL. When omitted (the deterministic path), the worker
    resolves the items from the persisted brief/state itself: ``concept_preview``
    renders ALL persisted concept specs; ``final`` renders one item per picked
    creative, threading ``parent_creative_id``. This removes the operator (an
    LLM) from the per-image loop — it triggers the stage render and the worker
    fans out deterministically over the persisted plan.
    """

    pipeline_id: str = Field(..., min_length=1)
    kind: Literal["concept_preview", "final"]
    items: list[RenderItem] | None = None


def _persisted_concept_specs(pipeline: dict[str, Any]) -> list[dict[str, Any]]:
    """Pull the persisted concept specs authored at brief time.

    The brief endpoint mirrors them onto ``config_draft.concepts`` (and the
    brief payload). Prefer config_draft (the read surfaces it directly); fall
    back to the linked brief payload's ``concepts`` for robustness.
    """
    config_draft = pipeline.get("config_draft")
    if isinstance(config_draft, dict):
        specs = config_draft.get("concepts")
        if isinstance(specs, list) and specs:
            return [s for s in specs if isinstance(s, dict)]
        payload = config_draft.get("image_payload")
        if isinstance(payload, dict):
            specs = payload.get("concepts")
            if isinstance(specs, list) and specs:
                return [s for s in specs if isinstance(s, dict)]
    brief_id = pipeline.get("image_brief_id")
    if brief_id:
        brief = _fetch_brief_for_read(str(brief_id))
        if brief and isinstance(brief.get("payload"), dict):
            specs = brief["payload"].get("concepts")
            if isinstance(specs, list) and specs:
                return [s for s in specs if isinstance(s, dict)]
    return []


def _already_rendered_concepts(brief_id: str, *, version_prefix: str) -> set[str]:
    """Concept labels already stored at a given version (for idempotent resume).

    A render that timed out partway leaves some concepts stored; resolving the
    deterministic batch skips those so a retry completes the REMAINDER instead
    of re-rendering — the exact production fix (pipeline stuck at 1/N concepts).
    """
    done: set[str] = set()
    for row in _fetch_brief_creatives(brief_id):
        version = str(row.get("version") or "")
        if version.startswith(version_prefix):
            concept = row.get("concept")
            if concept:
                done.add(str(concept))
    return done


def _resolve_render_items(
    pipeline: dict[str, Any], kind: str, brief_id: str
) -> tuple[list[RenderItem], list[str]]:
    """Build the deterministic render batch from the persisted plan.

    Returns ``(items, skipped)`` where ``skipped`` are concept labels already
    rendered (so the caller can report a clean idempotent no-op vs. an empty
    plan). For ``concept_preview`` the items are every persisted concept spec
    not yet stored at ``v0.ideation``; for ``final`` they are one item per
    picked creative (parent_creative_id threaded) not yet stored at ``v1``.
    """
    specs = _persisted_concept_specs(pipeline)
    if kind == "concept_preview":
        done = _already_rendered_concepts(brief_id, version_prefix="v0.ideation")
        items: list[RenderItem] = []
        skipped: list[str] = []
        for spec in specs:
            concept = str(spec.get("concept") or "").strip()
            prompt = str(spec.get("prompt") or "").strip()
            if not concept or not prompt:
                continue
            if concept in done:
                skipped.append(concept)
                continue
            items.append(
                RenderItem(
                    concept=concept,
                    prompt=prompt,
                    offer_text=spec.get("offer_text"),
                )
            )
        return items, skipped

    # final: one item per pick, parent = the picked creative; recover the
    # concept label + prompt from the picked creative and the persisted plan.
    picks = pipeline.get("picks")
    picked_ids = (
        picks.get("image", []) if isinstance(picks, dict) else []
    ) or []
    specs_by_concept = {
        str(s.get("concept")): s for s in specs if s.get("concept")
    }
    creatives = _fetch_brief_creatives(brief_id)
    by_id = {str(r.get("id")): r for r in creatives}
    done = _already_rendered_concepts(brief_id, version_prefix="v1")
    items = []
    skipped = []
    for cid in picked_ids:
        row = by_id.get(str(cid))
        if not row:
            continue
        concept = str(row.get("concept") or "").strip()
        if not concept:
            continue
        if concept in done:
            skipped.append(concept)
            continue
        spec = specs_by_concept.get(concept)
        prompt = (
            str(spec.get("prompt")).strip()
            if spec and spec.get("prompt")
            else None
        )
        if not prompt:
            # No persisted prompt for this pick — can't render deterministically.
            continue
        items.append(
            RenderItem(
                concept=concept,
                prompt=prompt,
                offer_text=(spec or {}).get("offer_text"),
                parent_creative_id=str(cid),
            )
        )
    return items, skipped


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

    # Resolve the deterministic batch. When the caller supplies items we honour
    # them (back-compat); when omitted we fan out over the PERSISTED plan so the
    # operator never has to author/loop items at render time.
    skipped: list[str] = []
    if body.items is not None:
        items = body.items
    else:
        items, skipped = _resolve_render_items(pipeline, body.kind, brief_id)
        if not items:
            # Nothing left to render: either the plan is empty or everything is
            # already done (idempotent resume). Return cleanly, not a 4xx.
            return {
                "ok": True,
                "renders": [],
                "total_cost_usd": 0.0,
                "errors": [],
                "skipped": skipped,
            }

    if body.kind == "final":
        missing = [it.concept for it in items if not it.parent_creative_id]
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
        for item in items:
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
        skipped=len(skipped),
        total_cost_usd=total_cost_usd,
    )
    return {
        "ok": True,
        "renders": renders,
        "total_cost_usd": round(total_cost_usd, 4),
        "errors": errors,
        "skipped": skipped,
    }


# ---------------------------------------------------------------------------
# POST /work/pipeline/tools/store_creative
# ---------------------------------------------------------------------------
#
# Subscription-backed render path. The operator generates the image bytes in
# its OWN container via Hermes' codex image provider (the manager's ChatGPT/
# Codex OAuth — $0, model gpt-image-2 through the Codex Responses
# image_generation tool) and POSTs the finished bytes here. This endpoint is
# the storage twin of /render's ``_render_one``: it uploads the bytes,
# records the creative + iteration + event rows, emits the SAME pipeline_events
# (task_running → task_done) and records a zero-cost line against
# ``openai-codex``. The only difference from /render is that the bytes arrive
# pre-rendered instead of being fetched from Kie — so the dashboard, the
# auto-advance trigger and the cost aggregator all behave identically.


class StoreCreativeInput(BaseModel):
    """POST body for ``/work/pipeline/tools/store_creative``.

    ``image_b64`` is the base64-encoded PNG the operator already rendered via
    the codex image provider. ``kind`` selects the stage/version (mirroring
    /render): ``concept_preview`` → ideation/v0.ideation, ``final`` →
    generation/v1.0. ``ratio`` is the canonical worker label and is stamped
    onto the creative + the storage path exactly as /render does.
    """

    pipeline_id: str = Field(..., min_length=1)
    kind: Literal["concept_preview", "final"]
    concept: str = Field(..., min_length=1)
    ratio: Literal["1x1", "9x16", "16x9"]
    version: str = Field(..., min_length=1)
    prompt: str = Field(..., min_length=1)
    image_b64: str = Field(..., min_length=1)
    offer_text: str | None = None
    parent_creative_id: str | None = None


@router.post(
    "/work/pipeline/tools/store_creative", dependencies=[Depends(verify_secret)]
)
async def store_creative(body: StoreCreativeInput) -> dict[str, Any]:
    """Store an operator-rendered (codex) image as a pipeline creative.

    The storage twin of /render: it takes pre-rendered bytes instead of
    calling Kie, then runs the SAME upload → record_creative_stage →
    task_running/task_done events → cost path. Cost is recorded against
    ``openai-codex`` with ``subtotal=0`` (the image was generated free on the
    manager's ChatGPT/Codex subscription). Finals require ``parent_creative_id``
    just like /render. Returns ``{creative_id, file_path_supabase, version}``.
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

    if body.kind == "final" and not body.parent_creative_id:
        raise HTTPException(
            status_code=400,
            detail="final renders require parent_creative_id",
        )

    try:
        image_bytes = base64.b64decode(body.image_b64, validate=True)
    except (binascii.Error, ValueError) as e:
        raise HTTPException(
            status_code=400, detail=f"image_b64 is not valid base64: {e}"
        ) from e
    if not image_bytes:
        raise HTTPException(status_code=400, detail="image_b64 decoded to empty")

    stage = _STORE_STAGE[body.kind]
    sb = get_supabase_admin()

    base_payload: dict[str, Any] = {
        "kind": "image",
        "concept": body.concept,
        "ratio": body.ratio,
    }
    if body.parent_creative_id:
        base_payload["parent_creative_id"] = body.parent_creative_id

    # Emit the same task lifecycle the /render path emits. The bytes are
    # already rendered, so queued→running→done collapses to running→done.
    running_id = emit_pipeline_event(
        pipeline_id=body.pipeline_id,
        kind=EVENT_TASK_RUNNING,
        stage=stage,
        payload=base_payload,
    )

    try:
        storage_path = build_creative_path(
            brief_id, body.concept, body.ratio, body.version
        )
        sb.storage.from_(BUCKET).upload(
            path=storage_path,
            file=image_bytes,
            file_options={"content-type": "image/png", "x-upsert": "true"},
        )
        insert = await record_creative_stage(
            brief_id=brief_id,
            file_path_supabase=storage_path,
            concept=body.concept,
            offer_text=body.offer_text,
            ratio=body.ratio,
            version=body.version,
            prompt_used={
                "model": "openai-codex/gpt-image-2",
                "prompt": body.prompt,
                "ratio": body.ratio,
                "stage": stage,
                # Operator authorship marker (the DB enum can't store it on
                # the author column — see module docstring).
                "author": "operator",
                "backend": "openai-codex",
                **(
                    {"parent_creative_id": body.parent_creative_id}
                    if body.parent_creative_id
                    else {}
                ),
            },
            iteration_kind="generate",
            iteration_content={
                "prompt": body.prompt,
                "pipeline_id": body.pipeline_id,
                "stage": stage,
                "author": "operator",
                "backend": "openai-codex",
            },
            # The iteration_author enum is ('user','ekko'); the operator is a
            # Hermes agent in the Ekko family, so we reuse 'ekko' here.
            author="ekko",
            parent_creative_id=body.parent_creative_id,
        )
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001
        log.warning(
            "operator_store_creative_failed",
            pipeline_id=body.pipeline_id,
            brief_id=brief_id,
            concept=body.concept,
            ratio=body.ratio,
            error=str(e),
        )
        err_payload = {**base_payload, "error": str(e)}
        emit_pipeline_event(
            pipeline_id=body.pipeline_id,
            kind=EVENT_TASK_ERROR,
            stage=stage,
            payload=err_payload,
        )
        raise HTTPException(
            status_code=502, detail=f"store_creative failed: {e}"
        ) from e

    done_payload = {
        **base_payload,
        "creative_id": insert.creative_id,
        "file_path_supabase": storage_path,
    }
    done_id = emit_pipeline_event(
        pipeline_id=body.pipeline_id,
        kind=EVENT_TASK_DONE,
        stage=stage,
        payload=done_payload,
    )
    # Zero-cost line: the image was generated on the manager's ChatGPT/Codex
    # subscription, so the worker pays nothing — but we still emit the cost
    # event so the aggregator and the dashboard timeline stay consistent with
    # the Kie path (which always emits a cost_recorded after task_done).
    emit_cost(
        pipeline_id=body.pipeline_id,
        api=_CODEX_COST_API,
        units=1,
        subtotal=0,
        task_event_id=done_id or running_id,
        stage=stage,
        extra={
            "creative_id": insert.creative_id,
            "ratio": body.ratio,
            "backend": "openai-codex",
        },
    )

    log.info(
        "operator_store_creative_done",
        pipeline_id=body.pipeline_id,
        brief_id=brief_id,
        concept=body.concept,
        ratio=body.ratio,
        version=body.version,
        creative_id=insert.creative_id,
        bytes=len(image_bytes),
    )
    return {
        "creative_id": insert.creative_id,
        "file_path_supabase": storage_path,
        "version": body.version,
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
    "ConceptSpec",
    "RenderInput",
    "RenderItem",
    "StoreCreativeInput",
    "DispatchInput",
    "EVENTS_TAIL_LIMIT",
]
