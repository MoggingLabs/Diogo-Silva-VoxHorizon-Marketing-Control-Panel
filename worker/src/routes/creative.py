"""Creative orchestration routes.

Two endpoints land in M2:

  POST /work/creative/generate
      body: { brief_id: str, prompts?: list[PromptItem] }
      Generates one or more PNGs for a brief. If ``prompts`` is supplied
      the worker honours it verbatim; otherwise it spawns a Claude Code
      subprocess loaded with the ``image-ad-prompting`` skill and asks
      the agent to produce a prompt pack from the brief payload.

  POST /work/creative/composite
      body: { creative_id, style, headline?, subtext?, cta?, offer_bar? }
      Pulls an existing creative from Supabase, runs
      ``image_compositor.py``, uploads the result as a new creative
      version, and returns the new ``creative_id``.

Both routes are protected by the shared-secret bearer auth applied at
the dependency layer.

The image-generation pipeline is intentionally serialized per brief via
the :class:`BriefQueue` — Kie.ai rate limits + the visual-verify SOP
forbid parallel runs within a single brief, but cross-brief parallelism
is fine.
"""

from __future__ import annotations

import json
import re
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

import structlog
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from ..auth import verify_secret
from ..services.atomic_inserts import Ratio, record_creative_stage
from ..services.claude_runner import ClaudeError, ClaudeRunner
from ..services.image_compositor import (
    CompositorError,
    CompositorStyle,
    composite as image_composite,
)
from ..services.kie import KieClient, KieError
from ..services.queue import get_queue
from ..services.storage import BUCKET, build_creative_path
from ..supabase_client import get_supabase_admin


log = structlog.get_logger(__name__)


router = APIRouter()


# ---------------------------------------------------------------------------
# Request / response schemas
# ---------------------------------------------------------------------------


class PromptItem(BaseModel):
    """One concept's worth of generation work.

    Each concept may produce multiple ratio variants — the inner list
    enumerates which ratios to render with which prompt body.
    """

    concept: str = Field(..., min_length=1, max_length=200)
    prompts: list["RatioPrompt"]


class RatioPrompt(BaseModel):
    """One ratio + prompt body pair within a concept."""

    ratio: Literal["1x1", "9x16"]
    text: str = Field(..., min_length=1, max_length=4000)


PromptItem.model_rebuild()


class CreativeGenerateInput(BaseModel):
    """POST body for ``/work/creative/generate``."""

    brief_id: str = Field(..., min_length=1)
    prompts: list[PromptItem] | None = None
    # Operator-iterating overrides: pin the version label so a regenerate
    # call lands on a known version. Defaults to "v1.0" for first runs;
    # callers regenerating against a parent_creative_id should bump.
    version: str = "v1.0"
    # When set, every generated row will have this parent_creative_id —
    # used by the iterate flow (M2-11).
    parent_creative_id: str | None = None
    # When the iterate flow regenerates from a chat prompt, this kind is
    # stamped on the iteration row. Default "generate" for new runs.
    iteration_kind: Literal["generate", "regenerate"] = "generate"
    # Override resolution. Kie.ai supports 1K/2K/4K; we default to 2K
    # which is the SOP-recommended quality for Meta ad delivery.
    resolution: Literal["1K", "2K", "4K"] = "2K"


class CreativeGeneratedItem(BaseModel):
    """One generated PNG's identifiers."""

    creative_id: str
    concept: str
    ratio: str
    version: str
    file_path_supabase: str
    task_id: str | None = None
    source_url: str | None = None


class CreativeGenerateResult(BaseModel):
    """Response body for ``/work/creative/generate``."""

    brief_id: str
    creatives_created: int
    creatives: list[CreativeGeneratedItem]
    errors: list[str]


class CreativeCompositeInput(BaseModel):
    """POST body for ``/work/creative/composite``."""

    creative_id: str = Field(..., min_length=1)
    style: Literal["bold-bottom", "offer-banner", "full-overlay", "minimal"] = "bold-bottom"
    headline: str = Field(..., min_length=1)
    subtext: str | None = None
    cta: str | None = None
    offer_bar: str | None = None
    city: str | None = None
    color: str | None = None
    accent_color: str | None = None
    version: str = "v1.1"


class CreativeCompositeResult(BaseModel):
    """Response body for ``/work/creative/composite``."""

    creative_id: str
    parent_creative_id: str
    file_path_supabase: str
    style: str


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _load_brief_row(brief_id: str) -> dict[str, Any]:
    """Fetch the brief row for ``brief_id`` or raise 404."""
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
    row = resp.data
    if not row:
        raise HTTPException(status_code=404, detail=f"brief not found: {brief_id}")
    return row


def _load_creative_row(creative_id: str) -> dict[str, Any]:
    """Fetch a creative row + the bytes-needed metadata or 404."""
    sb = get_supabase_admin()
    resp = (
        sb.table("creatives")
        .select(
            "id, brief_id, concept, offer_text, ratio, version, "
            "file_path_supabase, prompt_used"
        )
        .eq("id", creative_id)
        .maybe_single()
        .execute()
    )
    row = resp.data
    if not row:
        raise HTTPException(status_code=404, detail=f"creative not found: {creative_id}")
    return row


def _download_bytes(path: str, *, bucket: str = BUCKET) -> bytes:
    """Pull bytes from Supabase Storage. Mirrors :mod:`upload`'s helper."""
    sb = get_supabase_admin()
    resp = sb.storage.from_(bucket).download(path)
    if isinstance(resp, (bytes, bytearray)):
        return bytes(resp)
    raw = getattr(resp, "content", None)
    if isinstance(raw, (bytes, bytearray)):
        return bytes(raw)
    raise RuntimeError(f"unexpected Storage download response: {type(resp).__name__}")


def _upload_bytes(path: str, data: bytes, *, bucket: str = BUCKET) -> None:
    """Upload raw bytes to Supabase Storage."""
    sb = get_supabase_admin()
    sb.storage.from_(bucket).upload(
        path=path,
        file=data,
        file_options={"content-type": "image/png", "x-upsert": "true"},
    )


def _emit_event(*, kind: str, ref_id: str, payload: dict[str, Any]) -> None:
    """Append one ``events`` row. Failures log but never raise."""
    sb = get_supabase_admin()
    try:
        sb.table("events").insert(
            {
                "kind": kind,
                "ref_table": "creatives",
                "ref_id": ref_id,
                "payload": payload,
            }
        ).execute()
    except Exception as e:
        log.warning("creative_event_emit_failed", kind=kind, error=str(e))


_FENCED_JSON_RE = re.compile(r"```(?:json)?\s*(\{.*?\}|\[.*?\])\s*```", re.DOTALL)


def _parse_prompt_pack(stdout: str) -> list[PromptItem]:
    """Pull a prompt pack out of a Claude Code response.

    Accepts either:
      - a raw JSON array of ``{concept, prompts: [{ratio, text}]}`` items
        at the top of stdout, or
      - a fenced ```` ```json ```` block anywhere in stdout.

    Raises :class:`ValueError` when neither is parseable — the route
    surfaces this as a 502 so the operator sees the failure.
    """
    candidates: list[str] = []

    # Fenced first — most agents wrap structured output in fences.
    for match in _FENCED_JSON_RE.finditer(stdout):
        candidates.append(match.group(1))

    # Then try the raw stdout if no fences hit.
    trimmed = stdout.strip()
    if trimmed and (trimmed.startswith("[") or trimmed.startswith("{")):
        candidates.append(trimmed)

    last_err: Exception | None = None
    for raw in candidates:
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError as e:
            last_err = e
            continue
        if isinstance(parsed, dict):
            parsed = [parsed]
        if not isinstance(parsed, list):
            continue
        try:
            return [PromptItem(**item) for item in parsed]
        except Exception as e:
            last_err = e
            continue

    raise ValueError(
        f"Could not parse prompt pack from agent stdout: {last_err}"
    )


# Allow tests to substitute a runner without monkey-patching the import.
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


@dataclass(frozen=True)
class _GenerationContext:
    """All the brief-side metadata we need for one generate run."""

    brief_id: str
    payload: dict[str, Any]
    client_slug: str
    client_name: str


def _extract_context(brief_row: dict[str, Any]) -> _GenerationContext:
    """Project a brief row into the fields the generator actually uses."""
    payload = brief_row.get("payload")
    if not isinstance(payload, dict):
        payload = {}
    client = brief_row.get("clients") or {}
    if not isinstance(client, dict):
        client = {}
    return _GenerationContext(
        brief_id=brief_row["id"],
        payload=payload,
        client_slug=str(client.get("slug") or "client"),
        client_name=str(client.get("name") or client.get("slug") or "Client"),
    )


def _build_agent_prompt(ctx: _GenerationContext, *, image_count: int) -> str:
    """Compose the prompt fed to the ``image-ad-prompting`` skill.

    Produces a short instruction asking the agent to return a JSON array
    of concept prompt-packs. The agent is expected to draw on the
    ``image-ad-prompting`` skill (loaded via ``--skill``) for the SOP
    around visual style, brand consistency, etc.
    """
    payload = ctx.payload
    offer = payload.get("offer_text") or "(none)"
    market = payload.get("market") or "(unspecified)"
    angles = payload.get("angles") or []
    return (
        "You are generating an image-ad prompt pack for the marketing "
        f"control panel. Client: {ctx.client_name} ({ctx.client_slug}). "
        f"Market: {market}. Offer: {offer}. "
        f"Angles to explore: {angles}. "
        f"Produce {image_count} concept(s); each concept must include both "
        "1x1 and 9x16 prompts. Return ONLY a fenced ```json``` block whose "
        "body is a JSON array of `{\"concept\": str, \"prompts\": "
        "[{\"ratio\": \"1x1\"|\"9x16\", \"text\": str}]}` items."
    )


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@router.post(
    "/work/creative/generate",
    dependencies=[Depends(verify_secret)],
    response_model=CreativeGenerateResult,
)
async def generate_creative(body: CreativeGenerateInput) -> CreativeGenerateResult:
    """Generate one or more PNG creatives for a brief.

    Workflow:
      1. Look up the brief + client.
      2. If ``prompts`` was supplied, honour it; otherwise run Claude Code
         with the ``image-ad-prompting`` skill to build a prompt pack.
      3. Acquire the per-brief queue.
      4. For each ``(concept, ratio, text)``: call Kie.ai → upload to
         Storage → record_creative_stage. Errors are collected, not raised.
      5. Emit a roll-up ``creative_batch_generated`` event.
    """
    brief_row = _load_brief_row(body.brief_id)
    ctx = _extract_context(brief_row)

    # Resolve the prompt pack.
    if body.prompts:
        pack: list[PromptItem] = body.prompts
    else:
        image_count = 3
        creative_plan = ctx.payload.get("creative_plan") or {}
        if isinstance(creative_plan, dict):
            ic = creative_plan.get("image_count")
            if isinstance(ic, int) and 1 <= ic <= 20:
                image_count = ic

        agent_prompt = _build_agent_prompt(ctx, image_count=image_count)
        try:
            stdout = await _get_runner().run_subprocess(agent_prompt)
        except ClaudeError as e:
            log.warning("creative_agent_failed", brief_id=body.brief_id, error=str(e))
            raise HTTPException(status_code=502, detail=f"claude agent failed: {e}") from e

        try:
            pack = _parse_prompt_pack(stdout)
        except ValueError as e:
            raise HTTPException(
                status_code=502,
                detail=f"agent returned unparseable prompt pack: {e}",
            ) from e

    if not pack:
        raise HTTPException(
            status_code=502, detail="prompt pack is empty — nothing to generate"
        )

    # Generate every (concept, ratio) pair under the per-brief lock.
    kie_client = _make_kie_client()
    created: list[CreativeGeneratedItem] = []
    errors: list[str] = []
    queue = get_queue()

    async with queue.acquire(body.brief_id):
        for item in pack:
            for rp in item.prompts:
                try:
                    record = await _generate_one(
                        kie_client,
                        brief_id=body.brief_id,
                        concept=item.concept,
                        ratio=rp.ratio,
                        prompt_text=rp.text,
                        version=body.version,
                        resolution=body.resolution,
                        iteration_kind=body.iteration_kind,
                        parent_creative_id=body.parent_creative_id,
                        payload_offer=ctx.payload.get("offer_text"),
                    )
                    created.append(record)
                except (KieError, RuntimeError) as e:
                    log.warning(
                        "creative_one_failed",
                        brief_id=body.brief_id,
                        concept=item.concept,
                        ratio=rp.ratio,
                        error=str(e),
                    )
                    errors.append(
                        f"{item.concept}/{rp.ratio}: {e}"
                    )

    # Roll-up event for the audit table.
    _emit_event(
        kind="creative_batch_generated",
        ref_id=body.brief_id,
        payload={
            "brief_id": body.brief_id,
            "creatives_created": len(created),
            "errors": errors,
        },
    )

    return CreativeGenerateResult(
        brief_id=body.brief_id,
        creatives_created=len(created),
        creatives=created,
        errors=errors,
    )


@router.post(
    "/work/creative/composite",
    dependencies=[Depends(verify_secret)],
    response_model=CreativeCompositeResult,
)
async def composite_creative(body: CreativeCompositeInput) -> CreativeCompositeResult:
    """Composite a finished image creative into a styled variant.

    The output is a new ``creatives`` row pointing at the same brief and
    concept, with ``iteration_kind="annotate"`` to mark it as a stylistic
    derivative rather than a fresh generation.
    """
    parent = _load_creative_row(body.creative_id)
    if not parent.get("file_path_supabase"):
        raise HTTPException(status_code=409, detail="parent creative has no file yet")

    brief_id: str = parent["brief_id"]
    concept: str = parent.get("concept") or "concept"
    ratio: Ratio = (parent.get("ratio") or "1x1")  # type: ignore[assignment]

    # Pull the source bytes; write to a temp file the compositor can read.
    src_bytes = _download_bytes(parent["file_path_supabase"])

    with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as fh_in:
        in_path = Path(fh_in.name)
        fh_in.write(src_bytes)
    out_path = in_path.with_name(f"{in_path.stem}-composited.png")

    try:
        try:
            await image_composite(
                in_path,
                out_path,
                style=body.style,
                headline=body.headline,
                subtext=body.subtext,
                cta=body.cta,
                offer_bar=body.offer_bar,
                city=body.city,
                color=body.color,
                accent_color=body.accent_color,
                output_format="1x1" if ratio == "1x1" else "9x16",
            )
        except RuntimeError as e:
            # Upstream script not installed → 503.
            raise HTTPException(status_code=503, detail=str(e)) from e
        except CompositorError as e:
            raise HTTPException(status_code=502, detail=str(e)) from e

        composed_bytes = out_path.read_bytes()
    finally:
        for p in (in_path, out_path):
            try:
                p.unlink()
            except FileNotFoundError:
                pass

    storage_path = build_creative_path(brief_id, concept, ratio, body.version)
    _upload_bytes(storage_path, composed_bytes)

    insert_result = await record_creative_stage(
        brief_id=brief_id,
        file_path_supabase=storage_path,
        concept=concept,
        offer_text=parent.get("offer_text"),
        ratio=ratio,
        version=body.version,
        prompt_used={
            "kind": "composite",
            "style": body.style,
            "headline": body.headline,
            "subtext": body.subtext,
            "cta": body.cta,
            "offer_bar": body.offer_bar,
            "parent_creative_id": body.creative_id,
        },
        iteration_kind="annotate",
        iteration_content={
            "style": body.style,
            "headline": body.headline,
            "cta": body.cta,
            "parent_creative_id": body.creative_id,
        },
        author="ekko",
        parent_creative_id=body.creative_id,
    )

    return CreativeCompositeResult(
        creative_id=insert_result.creative_id,
        parent_creative_id=body.creative_id,
        file_path_supabase=storage_path,
        style=body.style,
    )


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _make_kie_client() -> KieClient:
    """Construct a KieClient, surfacing config errors as 503.

    Split into a function so tests can patch the constructor without
    touching the route definition.
    """
    try:
        return KieClient()
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e)) from e


async def _generate_one(
    kie_client: KieClient,
    *,
    brief_id: str,
    concept: str,
    ratio: Literal["1x1", "9x16"],
    prompt_text: str,
    version: str,
    resolution: Literal["1K", "2K", "4K"],
    iteration_kind: Literal["generate", "regenerate"],
    parent_creative_id: str | None,
    payload_offer: Any | None,
) -> CreativeGeneratedItem:
    """One concept-ratio: Kie → upload → record_creative_stage."""
    result = await kie_client.generate_image_full(
        prompt_text, ratio, resolution=resolution
    )

    storage_path = build_creative_path(brief_id, concept, ratio, version)
    _upload_bytes(storage_path, result.image_bytes)

    insert = await record_creative_stage(
        brief_id=brief_id,
        file_path_supabase=storage_path,
        concept=concept,
        offer_text=str(payload_offer) if payload_offer else None,
        ratio=ratio,
        version=version,
        prompt_used={
            "model": "kie/nano-banana-2",
            "prompt": prompt_text,
            "ratio": ratio,
            "resolution": resolution,
            "task_id": result.task_id,
            "source_url": result.source_url,
        },
        iteration_kind=iteration_kind,
        iteration_content={
            "prompt": prompt_text,
            "task_id": result.task_id,
            "source_url": result.source_url,
        },
        author="ekko",
        parent_creative_id=parent_creative_id,
    )

    return CreativeGeneratedItem(
        creative_id=insert.creative_id,
        concept=concept,
        ratio=ratio,
        version=version,
        file_path_supabase=storage_path,
        task_id=result.task_id,
        source_url=result.source_url,
    )
