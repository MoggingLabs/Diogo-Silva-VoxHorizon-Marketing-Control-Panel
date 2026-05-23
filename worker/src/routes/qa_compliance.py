"""Compliance + QA adjudication endpoints (P2 wiring, #341 / #342).

These two routes are the HTTP wiring for Layer 3 of the pipeline rebuild
(``PIPELINE-REBUILD-ARCHITECTURE.md``). The pure engines
(:mod:`worker.src.services.compliance_engine` /
:mod:`worker.src.services.qa_engine`) already adjudicate a creative; this
module is the worker-owned persistence + verdict layer on top of them:

  POST /work/pipeline/tools/compliance_run
      The operator submits **candidate** LLM findings only. For each item the
      WORKER builds the engine context (the creative + the client's
      ``offer_constraints``), calls ``compliance_engine.evaluate(...)``, writes
      the adjudicated findings to ``compliance_finding`` (append-only,
      tamper-evident evidence), and upserts the rolled-up verdict onto
      ``creative_stage_state(stage='compliance_review')``. The operator has NO
      path to write a pass — the verdict is always the engine's. ``fail`` on a
      block-severity finding fails the gate; ``needs_review`` holds it pending;
      only an all-clear ``pass`` clears it.

  POST /work/pipeline/tools/qa_run
      The QA twin. The operator submits **candidate** vision findings; the
      worker fetches the image bytes (operator-supplied base64 OR a Storage
      download of the creative's ``file_path_supabase``), runs its own
      deterministic Pillow backstops, adjudicates the vision candidates via
      ``qa_engine.evaluate(...)``, writes the verdict to ``qa_result``
      (append-only, one row per attempt), and upserts
      ``creative_stage_state(stage='creative_qa')``. A ``fail`` flags a
      re-render; one failed creative never blocks the others.

Persistence mirrors the patterns in :mod:`worker.src.routes.pipeline_tools`:
``get_supabase_admin()`` → ``table(...).insert/update().execute()`` and the
same bearer auth via :func:`verify_secret`. The new tables are referenced by
NAME (the 0018 / 0021 migrations are on ``main`` but not yet applied live), so
there are no generated types and tests drive the in-memory ``fake_supabase``
double, never a live DB.
"""

from __future__ import annotations

import base64
import binascii
from typing import Any, Literal

import structlog
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from ..auth import verify_secret
from ..services import compliance_engine, qa_engine
from ..services.storage import BUCKET
from ..supabase_client import get_supabase_admin


log = structlog.get_logger(__name__)


router = APIRouter()


# ---------------------------------------------------------------------------
# Enum / verdict mapping (engine outputs -> DB enums from 0017 / 0021)
# ---------------------------------------------------------------------------
#
# The engines speak a small severity vocabulary (``info`` / ``warn`` / ``block``
# for compliance, ``critical`` / ``major`` / ``minor`` for QA). The DB
# ``verdict_severity_enum`` is ``info | low | medium | high | critical``; map
# onto it so the persisted evidence pins a valid enum value.
_COMPLIANCE_SEVERITY_TO_DB: dict[str, str] = {
    "info": "info",
    "warn": "medium",
    "block": "critical",
}
_QA_SEVERITY_TO_DB: dict[str, str] = {
    "minor": "low",
    "major": "high",
    "critical": "critical",
}

# Engine verdict (``pass`` / ``fail`` / ``needs_review``) -> the per-(creative,
# stage) ``stage_state_enum`` rollup the gate predicate reads. A block fails the
# unit; ``needs_review`` / ``pending`` holds it; only an all-clear passes.
_VERDICT_TO_STAGE_STATE: dict[str, str] = {
    "pass": "passed",
    "fail": "failed",
    "needs_review": "pending",
}


# ---------------------------------------------------------------------------
# Request models
# ---------------------------------------------------------------------------


class LLMCandidate(BaseModel):
    """One operator-supplied compliance candidate finding (never a verdict).

    The operator (or its sub-agent) classifies a creative against an ``llm`` /
    ``both`` rule and submits the *candidate* here; the worker adjudicates it
    against the rule's confidence floor. Extra keys are allowed so a richer
    candidate (rationale, bbox) rides along without a schema bump.
    """

    model_config = {"extra": "allow"}

    rule_id: str = Field(..., min_length=1)
    label: str = Field(..., min_length=1)
    confidence: float | None = None
    evidence_span: str | None = None


class ComplianceItem(BaseModel):
    """One creative/copy unit to adjudicate for compliance."""

    creative_id: str = Field(..., min_length=1)
    copy_variant_id: str | None = None
    surface: Literal["image", "copy", "targeting"] = "copy"
    vertical: str | None = None
    llm_candidates: list[LLMCandidate] = Field(default_factory=list)


class ComplianceRunInput(BaseModel):
    """POST body for ``/work/pipeline/tools/compliance_run``."""

    pipeline_id: str = Field(..., min_length=1)
    items: list[ComplianceItem] = Field(..., min_length=1)


class VisionCandidate(BaseModel):
    """One operator-supplied QA vision candidate (never a verdict).

    Matched to a rubric item by ``check_id``; the worker scores it against the
    item's threshold. ``score`` (0..1 or 0..100) or ``label``
    (``pass`` / ``fail`` / ``uncertain``) carries the observation. Extra keys
    (``note``, ``bbox``) are allowed.
    """

    model_config = {"extra": "allow"}

    check_id: str = Field(..., min_length=1)
    score: float | None = None
    label: str | None = None
    note: str | None = None


class QAItem(BaseModel):
    """One creative to adjudicate for QA."""

    creative_id: str = Field(..., min_length=1)
    surface: Literal["image"] = "image"
    vertical: str | None = None
    ratio: str = "1x1"
    # Operator-supplied bytes (the common path: the operator already holds the
    # render). When omitted the worker downloads the creative's
    # ``file_path_supabase`` from Storage.
    image_b64: str | None = None
    overlay_region: dict[str, int] | None = None
    vision_candidates: list[VisionCandidate] = Field(default_factory=list)


class QARunInput(BaseModel):
    """POST body for ``/work/pipeline/tools/qa_run``."""

    pipeline_id: str = Field(..., min_length=1)
    items: list[QAItem] = Field(..., min_length=1)


# ---------------------------------------------------------------------------
# Shared fetch helpers (mirror pipeline_tools.py read patterns)
# ---------------------------------------------------------------------------


def _fetch_creative(creative_id: str) -> dict[str, Any] | None:
    """Pull the creative columns the engines + persistence need, or None."""
    sb = get_supabase_admin()
    resp = (
        sb.table("creatives")
        .select(
            "id, brief_id, concept, ratio, version, type, "
            "file_path_supabase, has_overlay_text"
        )
        .eq("id", creative_id)
        .maybe_single()
        .execute()
    )
    return resp.data if (resp is not None and isinstance(resp.data, dict)) else None


def _fetch_copy_variant(copy_variant_id: str) -> dict[str, Any] | None:
    """Pull the copy fields the compliance engine reads, or None."""
    sb = get_supabase_admin()
    resp = (
        sb.table("copy_variants")
        .select("id, headline, body, description, cta")
        .eq("id", copy_variant_id)
        .maybe_single()
        .execute()
    )
    return resp.data if (resp is not None and isinstance(resp.data, dict)) else None


def _fetch_client_for_pipeline(pipeline_id: str) -> dict[str, Any] | None:
    """Resolve the pipeline's client (service_type + offer_constraints).

    Returns ``{service_type, offer_constraints: [...]}`` for the engine's
    per-client ``do_not_say`` synthesis, or ``None`` when the pipeline has no
    linked client (an unconstrained, generic vertical).
    """
    sb = get_supabase_admin()
    p_resp = (
        sb.table("pipelines")
        .select("id, client_id")
        .eq("id", pipeline_id)
        .maybe_single()
        .execute()
    )
    pipeline = p_resp.data if (p_resp is not None and isinstance(p_resp.data, dict)) else None
    if not pipeline:
        return None
    client_id = pipeline.get("client_id")
    if not client_id:
        return None

    c_resp = (
        sb.table("clients")
        .select("id, service_type")
        .eq("id", str(client_id))
        .maybe_single()
        .execute()
    )
    client = c_resp.data if (c_resp is not None and isinstance(c_resp.data, dict)) else None
    constraints = _fetch_offer_constraints(str(client_id))
    return {
        "service_type": (client or {}).get("service_type"),
        "offer_constraints": constraints,
    }


def _fetch_offer_constraints(client_id: str) -> list[str]:
    """Return the client's do-not-say constraint texts, source order."""
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


def _upsert_stage_state(
    *,
    pipeline_id: str,
    creative_id: str,
    stage: str,
    status: str,
    summary: dict[str, Any],
    decided_by: str = "worker",
) -> None:
    """Upsert the per-(creative,stage) rollup verdict on creative_stage_state.

    The table has ``unique(creative_id, stage)`` (0018); we emulate the upsert
    by updating the matching row and inserting when none exists, so the route
    works against both a live DB and the in-memory test double. The worker
    NEVER writes ``overridden`` here — that is the manager override route's job;
    a worker-written verdict is only ``passed`` / ``failed`` / ``pending``.
    """
    from datetime import datetime, timezone

    sb = get_supabase_admin()
    now = datetime.now(timezone.utc).isoformat()
    patch = {
        "status": status,
        "summary": summary,
        "decided_by": decided_by,
        "decided_at": now,
    }

    existing = (
        sb.table("creative_stage_state")
        .select("id")
        .eq("creative_id", creative_id)
        .eq("stage", stage)
        .maybe_single()
        .execute()
    )
    row = existing.data if (existing is not None and isinstance(existing.data, dict)) else None
    if row and row.get("id"):
        (
            sb.table("creative_stage_state")
            .update(patch)
            .eq("creative_id", creative_id)
            .eq("stage", stage)
            .execute()
        )
    else:
        sb.table("creative_stage_state").insert(
            {
                "pipeline_id": pipeline_id,
                "creative_id": creative_id,
                "stage": stage,
                **patch,
            }
        ).execute()


# ---------------------------------------------------------------------------
# POST /work/pipeline/tools/compliance_run
# ---------------------------------------------------------------------------


def _build_compliance_context(
    item: ComplianceItem,
    creative: dict[str, Any],
    copy_row: dict[str, Any] | None,
    client: dict[str, Any] | None,
) -> dict[str, Any]:
    """Assemble the engine context for one compliance item."""
    return {
        "creative": {
            "id": creative.get("id"),
            "concept": creative.get("concept"),
            "ratio": creative.get("ratio"),
            "has_overlay_text": creative.get("has_overlay_text"),
        },
        "copy": (
            {
                "headline": copy_row.get("headline"),
                "body": copy_row.get("body"),
                "description": copy_row.get("description"),
                "cta": copy_row.get("cta"),
            }
            if copy_row
            else None
        ),
        "client": {
            "service_type": (client or {}).get("service_type") or item.vertical,
            "offer_constraints": (client or {}).get("offer_constraints") or [],
        },
        "surface": item.surface,
    }


def _persist_compliance_findings(
    *,
    pipeline_id: str,
    item: ComplianceItem,
    result: compliance_engine.EvaluationResult,
) -> int:
    """Write one append-only compliance_finding row per engine finding.

    Returns the number of rows written. Only non-``pass`` findings are recorded
    as evidence (the audit trail records what fired); a fully clean run writes
    no finding rows but still upserts the ``passed`` verdict on the gate.
    """
    sb = get_supabase_admin()
    written = 0
    for finding in result.findings:
        if finding.verdict == "pass":
            continue
        row: dict[str, Any] = {
            "pipeline_id": pipeline_id,
            "creative_id": item.creative_id,
            "copy_variant_id": item.copy_variant_id,
            "pass": 1,
            "rule_id": finding.rule_id,
            "rule_version": _coerce_rule_version(finding.version),
            "severity": _COMPLIANCE_SEVERITY_TO_DB.get(finding.severity, "medium"),
            "verdict": finding.verdict,
            "evidence": {"detail": finding.evidence},
            "required_edit": finding.required_edit,
            "citation_url": finding.citation_url,
            "checked_by": "worker",
        }
        sb.table("compliance_finding").insert(row).execute()
        written += 1
    return written


def _coerce_rule_version(version: str) -> int:
    """compliance_finding.rule_version is an int; engine carries a string.

    Synthesized per-client rules use ``"client"`` (non-numeric) — map those (and
    any unparseable version) to ``0`` so the evidence row still persists.
    """
    try:
        return int(version)
    except (TypeError, ValueError):
        return 0


@router.post(
    "/work/pipeline/tools/compliance_run", dependencies=[Depends(verify_secret)]
)
async def compliance_run(body: ComplianceRunInput) -> dict[str, Any]:
    """Adjudicate compliance for a batch of creatives; persist verdict + evidence.

    The operator submits candidate findings only. For each item the worker
    builds the engine context, calls ``compliance_engine.evaluate(...)``, writes
    the adjudicated findings to ``compliance_finding`` and rolls the verdict up
    onto ``creative_stage_state(compliance_review)``. There is no path for the
    operator to assert a pass — the verdict is always the engine's. A missing
    creative fails that one item (recorded in ``errors``) without aborting the
    batch.
    """
    client = _fetch_client_for_pipeline(body.pipeline_id)

    results: list[dict[str, Any]] = []
    errors: list[dict[str, Any]] = []
    for item in body.items:
        creative = _fetch_creative(item.creative_id)
        if creative is None:
            errors.append(
                {"creative_id": item.creative_id, "error": "creative not found"}
            )
            continue

        copy_row = (
            _fetch_copy_variant(item.copy_variant_id)
            if item.copy_variant_id
            else None
        )
        context = _build_compliance_context(item, creative, copy_row, client)
        candidates = [c.model_dump(exclude_none=True) for c in item.llm_candidates]

        result = compliance_engine.evaluate(context, llm_candidates=candidates)
        verdict = result.overall_verdict
        status = _VERDICT_TO_STAGE_STATE[verdict]

        block_findings = [
            f.to_dict()
            for f in result.findings
            if f.verdict == "fail" and f.severity == "block"
        ]
        summary = {
            "stage": "compliance_review",
            "verdict": verdict,
            "finding_count": len(result.findings),
            "block_count": len(block_findings),
            "blocks": block_findings,
        }

        written = _persist_compliance_findings(
            pipeline_id=body.pipeline_id, item=item, result=result
        )
        _upsert_stage_state(
            pipeline_id=body.pipeline_id,
            creative_id=item.creative_id,
            stage="compliance_review",
            status=status,
            summary=summary,
        )

        results.append(
            {
                "creative_id": item.creative_id,
                "copy_variant_id": item.copy_variant_id,
                "verdict": verdict,
                "status": status,
                "findings_written": written,
                "block_count": len(block_findings),
            }
        )

    rollup = _rollup_verdict([r["status"] for r in results])
    log.info(
        "compliance_run_done",
        pipeline_id=body.pipeline_id,
        items=len(body.items),
        adjudicated=len(results),
        errors=len(errors),
        rollup=rollup,
    )
    return {
        "ok": True,
        "pipeline_id": body.pipeline_id,
        "stage": "compliance_review",
        "rollup": rollup,
        "results": results,
        "errors": errors,
    }


# ---------------------------------------------------------------------------
# POST /work/pipeline/tools/qa_run
# ---------------------------------------------------------------------------


def _resolve_image_bytes(item: QAItem, creative: dict[str, Any]) -> bytes:
    """Resolve the creative's image bytes for the QA engine.

    Prefers operator-supplied ``image_b64`` (the common path — the operator
    already holds the render); otherwise downloads ``file_path_supabase`` from
    Storage. Raises :class:`HTTPException` (422) on a malformed base64 payload
    and (502) on a Storage download failure so the caller sees a precise reason.
    """
    if item.image_b64:
        try:
            return base64.b64decode(item.image_b64, validate=True)
        except (binascii.Error, ValueError) as e:
            raise HTTPException(
                status_code=422, detail=f"image_b64 is not valid base64: {e}"
            ) from e

    path = creative.get("file_path_supabase")
    if not path:
        raise HTTPException(
            status_code=422,
            detail="creative has no file_path_supabase and no image_b64 supplied",
        )
    sb = get_supabase_admin()
    try:
        data = sb.storage.from_(BUCKET).download(str(path))
    except Exception as e:  # noqa: BLE001 — surface a clean 502 to the operator
        raise HTTPException(
            status_code=502, detail=f"failed to download creative bytes: {e}"
        ) from e
    return bytes(data) if data else b""


def _persist_qa_result(
    *,
    pipeline_id: str,
    item: QAItem,
    report: qa_engine.QAReport,
) -> int:
    """Append one qa_result row (one per attempt) and return its attempt number.

    ``qa_result`` is ``unique(creative_id, attempt)``; we compute the next
    attempt from the count of existing rows so a re-run after a re-render is a
    fresh, append-only attempt rather than an overwrite.
    """
    sb = get_supabase_admin()
    existing = (
        sb.table("qa_result")
        .select("id, attempt")
        .eq("creative_id", item.creative_id)
        .execute()
    )
    rows = existing.data if (existing is not None and isinstance(existing.data, list)) else []
    attempt = len(rows) + 1

    report_dict = report.to_dict()
    sb.table("qa_result").insert(
        {
            "pipeline_id": pipeline_id,
            "creative_id": item.creative_id,
            "attempt": attempt,
            "status": report.status,
            "defects": report_dict["defects"],
            "checks": report_dict["checks"],
            "checked_by": "worker",
        }
    ).execute()
    return attempt


@router.post("/work/pipeline/tools/qa_run", dependencies=[Depends(verify_secret)])
async def qa_run(body: QARunInput) -> dict[str, Any]:
    """Adjudicate creative QA for a batch; persist verdict + evidence.

    The operator submits candidate vision findings only. The worker fetches the
    image bytes, runs its deterministic Pillow backstops, adjudicates the vision
    candidates via ``qa_engine.evaluate(...)``, appends a ``qa_result`` row, and
    rolls the verdict onto ``creative_stage_state(creative_qa)``. A ``fail``
    flags a re-render (``rerender_recommended``); one failed creative never
    blocks the others.
    """
    results: list[dict[str, Any]] = []
    errors: list[dict[str, Any]] = []
    for item in body.items:
        creative = _fetch_creative(item.creative_id)
        if creative is None:
            errors.append(
                {"creative_id": item.creative_id, "error": "creative not found"}
            )
            continue

        image_bytes = _resolve_image_bytes(item, creative)

        overlay = None
        if item.overlay_region:
            r = item.overlay_region
            overlay = qa_engine.OverlayRegion(
                x=int(r.get("x", 0)),
                y=int(r.get("y", 0)),
                width=int(r.get("width", 0)),
                height=int(r.get("height", 0)),
            )
        context = qa_engine.QAContext(
            ratio=item.ratio,
            vertical=item.vertical,
            overlay_region=overlay,
        )
        candidates = [c.model_dump(exclude_none=True) for c in item.vision_candidates]

        report = qa_engine.evaluate(
            image_bytes, context=context, vision_candidates=candidates
        )
        status = _VERDICT_TO_STAGE_STATE[report.status]

        summary = {
            "stage": "creative_qa",
            "verdict": report.status,
            "rerender_recommended": report.rerender_recommended,
            "rubric_version": report.rubric_version,
            "defect_count": len(report.defects),
        }

        attempt = _persist_qa_result(
            pipeline_id=body.pipeline_id, item=item, report=report
        )
        _upsert_stage_state(
            pipeline_id=body.pipeline_id,
            creative_id=item.creative_id,
            stage="creative_qa",
            status=status,
            summary=summary,
        )

        results.append(
            {
                "creative_id": item.creative_id,
                "verdict": report.status,
                "status": status,
                "attempt": attempt,
                "rerender_recommended": report.rerender_recommended,
                "defect_count": len(report.defects),
            }
        )

    rollup = _rollup_verdict([r["status"] for r in results])
    log.info(
        "qa_run_done",
        pipeline_id=body.pipeline_id,
        items=len(body.items),
        adjudicated=len(results),
        errors=len(errors),
        rollup=rollup,
    )
    return {
        "ok": True,
        "pipeline_id": body.pipeline_id,
        "stage": "creative_qa",
        "rollup": rollup,
        "results": results,
        "errors": errors,
    }


# ---------------------------------------------------------------------------
# Shared rollup
# ---------------------------------------------------------------------------


def _rollup_verdict(statuses: list[str]) -> str:
    """Roll per-creative ``stage_state`` statuses up to a batch verdict.

    Mirrors the gate predicate's spirit: ``failed`` if any unit failed; else
    ``pending`` if any is non-terminal (needs review); else ``passed`` when at
    least one unit was adjudicated; ``pending`` for an empty batch (nothing
    cleared).
    """
    if not statuses:
        return "pending"
    if any(s == "failed" for s in statuses):
        return "failed"
    if any(s not in ("passed", "overridden", "skipped") for s in statuses):
        return "pending"
    return "passed"


__all__ = [
    "router",
    "ComplianceRunInput",
    "ComplianceItem",
    "LLMCandidate",
    "QARunInput",
    "QAItem",
    "VisionCandidate",
]
