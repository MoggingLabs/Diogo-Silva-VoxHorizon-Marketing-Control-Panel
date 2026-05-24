"""Integrations + monitor + observability routes (P5 / #364 #365 #367 #368 #369).

Layer 6 of the rebuild (PIPELINE-REBUILD-ARCHITECTURE.md). The locked owner
decision: **Meta + Drive are operator-held MCP** — the operator creates the ad
entities + uploads the Drive assets via its claude.ai MCP, and the *worker is
the recorder*. So nothing here calls Meta or Drive; these endpoints RECORD what
the operator already did and ENFORCE the server-side gates the operator must not
clear itself. GHL is the one net-new worker-side connector
(:mod:`services.ghl`), read-only.

Endpoints (all bearer-authed via :func:`verify_secret`):

  POST /work/pipeline/tools/launch
      The launch RECORDER + the HARD launch gate (#364/#365). Re-checks the
      launch preconditions SERVER-SIDE from the DB (spec-pass ∧ compliance-clear
      ∧ ≥3 approved copy), requires a recorded manager ``approved_by``, then
      records the operator-supplied Meta entity ids into ``ad_entity``
      (PAUSED-first; ``unique(kind, meta_id)`` makes a re-record idempotent) and
      stamps the ``launch_packages`` gate columns. It does NOT activate on Meta
      — the operator's MCP does that behind the approval gate; this gates +
      records.

  POST /work/pipeline/tools/finalize_drive
      Record the Drive URLs the operator uploaded, md5-verified (#364). Stamps
      ``creatives.drive_folder_id`` / ``finalized_at`` / ``finalize_verified``.

  POST /work/ghl/webhook
      Ingest a GHL lead webhook, deduped via ``integration_event_inbox`` (#366).

  GET  /work/metrics
      Observability snapshot: outbox depth, breaker state, in-flight dispatches,
      cost-vs-cap (#369).

Plus two pure, unit-tested cores wired by cron later (noted, not scheduled):

  * :func:`reconcile_pipeline` — daily reconciliation (#366/#367): pull GHL
    leads via :class:`GhlClient`, read Meta spend from ``cost_ledger``, compute
    real CPL, and write a ``campaign_perf_image`` row.
  * the watchdog cores live in :mod:`services.observability`.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

import structlog
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from ..auth import verify_secret
from ..generated.db_enums import AD_ENTITY_KINDS
from ..services import cost_ledger, observability
from ..services.ghl import GhlClient, GhlError, parse_webhook_event, real_cpl
from ..services.pipeline_runner import emit_pipeline_event, fetch_pipeline
from ..supabase_client import get_supabase_admin


log = structlog.get_logger(__name__)


router = APIRouter()


# Minimum approved copy variants required to clear the launch gate (LaunchGate
# precondition, Layer 5). Mirrors the dashboard checklist so the two agree.
MIN_APPROVED_COPY = 3

# Good (cleared) creative_stage_state statuses (stage_state_enum). A per-creative
# stage is cleared when every IN-SCOPE row is in one of these. This set MIRRORS
# the SQL ``pipeline_rollup_cleared`` (migration 0039, the single authority); a
# cross-language parity contract test (tests/test_rollup_parity.py) reads 0039 and
# fails CI if this set or the killed-exclusion rule drifts from the SQL. The
# membership set is a curated subset of the generated ``STAGE_STATES`` (the
# terminal-good states), so adding/removing a stage_state value surfaces here too.
_CLEARED_STAGE_STATUSES: frozenset[str] = frozenset(
    {"passed", "overridden", "skipped"}
)

# ad_entity kinds the launch recorder accepts, from the generated
# ``ad_entity_kind_enum`` mirror.
_AD_ENTITY_KINDS: frozenset[str] = frozenset(AD_ENTITY_KINDS)


# ===========================================================================
# Transactional outbox enqueue (E5.1)
# ===========================================================================
#
# The external-write recorder routes below enqueue an ``integration_outbox`` row
# alongside the state change they record, so the durable side effect the operator
# cannot itself guarantee (a Meta activation follow-through, a Drive index/notify)
# is applied EXACTLY ONCE and is retryable across a crash. The relay drainer
# (:mod:`services.outbox_relay`) claims + performs + records each row.
#
# supabase-py is not transactional (see :mod:`services.atomic_inserts` for the
# same accepted constraint), so "same transaction" here is the worker's practical
# equivalent: the outbox INSERT is the LAST write in the handler, after the state
# change has landed. The ``idempotency_key`` UNIQUE constraint (migration 0023)
# is the exactly-once backstop -- a re-run of the same recorder (the operator
# retries the call) finds the row already enqueued and does not double-enqueue,
# so the side effect fires once even though the recorder ran twice.


def enqueue_outbox(
    *,
    integration: str,
    op: str,
    idempotency_key: str,
    request: dict[str, Any],
    pipeline_id: str | None = None,
) -> bool:
    """Enqueue one ``integration_outbox`` row, idempotent on ``idempotency_key``.

    Returns True when a new row was enqueued, False when an identical key already
    exists (a recorder re-run) -- so the side effect is enqueued exactly once
    regardless of how many times the recorder is replayed. A duplicate-key INSERT
    that races past the probe is caught + treated as already-enqueued, so two
    concurrent recorders never both create the side effect.
    """
    sb = get_supabase_admin()
    existing = (
        sb.table("integration_outbox")
        .select("id")
        .eq("idempotency_key", idempotency_key)
        .maybe_single()
        .execute()
    )
    if existing is not None and isinstance(existing.data, dict):
        log.info("outbox_enqueue_deduped", idempotency_key=idempotency_key, op=op)
        return False
    try:
        sb.table("integration_outbox").insert(
            {
                "pipeline_id": pipeline_id,
                "integration": integration,
                "op": op,
                "idempotency_key": idempotency_key,
                "request": request,
                "status": "pending",
            }
        ).execute()
    except Exception as exc:  # noqa: BLE001 -- a unique-key race == already enqueued
        log.info(
            "outbox_enqueue_conflict",
            idempotency_key=idempotency_key,
            op=op,
            error=str(exc),
        )
        return False
    log.info("outbox_enqueued", idempotency_key=idempotency_key, integration=integration, op=op)
    return True


# ===========================================================================
# Launch precondition re-check (server-side, the HARD gate)
# ===========================================================================


@dataclass(frozen=True)
class LaunchPreconditions:
    """Server-side launch precondition verdict for a pipeline.

    ``ok`` is the AND of all three checks; the booleans + counts give the route
    a precise 422 detail so the operator/dashboard sees exactly what's missing.
    """

    spec_pass: bool
    compliance_clear: bool
    approved_copy_count: int
    copy_ge_3: bool
    ok: bool

    def as_dict(self) -> dict[str, Any]:
        return {
            "spec_pass": self.spec_pass,
            "compliance_clear": self.compliance_clear,
            "approved_copy_count": self.approved_copy_count,
            "copy_ge_3": self.copy_ge_3,
            "ok": self.ok,
        }


def _killed_creative_ids(pipeline_id: str) -> set[str]:
    """The set of KILLED image-creative ids for a pipeline (out of gate scope).

    A killed creative must never hold a gate (parity with the SQL
    ``pipeline_rollup_cleared`` / the grid / the advance route). Only image
    creatives can be ``killed`` (video_creative_status has no such value), so this
    reads ``creatives``. A read miss returns an empty set: excluding FEWER
    creatives only ever makes the launch gate STRICTER, never looser, so it can
    never let an unqualified pipeline through.
    """
    sb = get_supabase_admin()
    resp = (
        sb.table("creatives")
        .select("id")
        .eq("pipeline_id", pipeline_id)
        .eq("status", "killed")
        .execute()
    )
    rows = resp.data if (resp is not None and isinstance(resp.data, list)) else []
    return {str(r["id"]) for r in rows if isinstance(r, dict) and r.get("id")}


def _stage_cleared(pipeline_id: str, stage: str) -> bool:
    """True iff every IN-SCOPE ``creative_stage_state`` row for (pipeline, stage) cleared.

    Mirrors the SQL ``pipeline_rollup_cleared`` (migration 0039, the single
    authority) in Python so it reads through the in-memory test double + is
    auditable here: there must be ≥1 in-scope row for the stage and EVERY in-scope
    row must be ``passed | overridden | skipped``. A KILLED creative is dropped
    from the scope (it must not hold the gate). Zero in-scope rows ⇒ not cleared
    (the stage never ran). We re-derive this server-side at launch commit rather
    than trusting a stored flag — the architecture's "preconditions re-checked at
    commit" requirement (#365).
    """
    sb = get_supabase_admin()
    resp = (
        sb.table("creative_stage_state")
        .select("status, creative_id")
        .eq("pipeline_id", pipeline_id)
        .eq("stage", stage)
        .execute()
    )
    rows = resp.data if (resp is not None and isinstance(resp.data, list)) else []
    killed = _killed_creative_ids(pipeline_id)
    in_scope = [
        r
        for r in rows
        if isinstance(r, dict) and str(r.get("creative_id") or "") not in killed
    ]
    if not in_scope:
        return False
    return all(r.get("status") in _CLEARED_STAGE_STATUSES for r in in_scope)


def _count_approved_copy(pipeline_id: str, *, table: str = "copy_variants") -> int:
    """Count ``{table}`` rows in ``status='approved'`` for the pipeline.

    ``table`` is ``copy_variants`` (image) or ``video_copy_variants`` (video).
    """
    sb = get_supabase_admin()
    resp = (
        sb.table(table)
        .select("id, status")
        .eq("pipeline_id", pipeline_id)
        .eq("status", "approved")
        .execute()
    )
    rows = resp.data if (resp is not None and isinstance(resp.data, list)) else []
    return sum(1 for r in rows if isinstance(r, dict) and r.get("status") == "approved")


def check_launch_preconditions(pipeline_id: str) -> LaunchPreconditions:
    """Re-validate the three LaunchGate preconditions SERVER-SIDE from the DB.

    spec-pass ∧ compliance-clear ∧ ≥3 approved copy. This is the gate's source
    of truth — the route refuses to record a launch when ``ok`` is False, so a
    stale dashboard checklist or a since-rearmed compliance unit can never let
    an unqualified pipeline through. Video pipelines keep their approved copy in
    ``video_copy_variants``, so we count the format's copy table.
    """
    pipeline = fetch_pipeline(pipeline_id)
    is_video = bool(pipeline) and pipeline.get("format_choice") == "video"
    copy_table = "video_copy_variants" if is_video else "copy_variants"
    spec_pass = _stage_cleared(pipeline_id, "spec_validation")
    compliance_clear = _stage_cleared(pipeline_id, "compliance_review")
    approved = _count_approved_copy(pipeline_id, table=copy_table)
    copy_ge_3 = approved >= MIN_APPROVED_COPY
    return LaunchPreconditions(
        spec_pass=spec_pass,
        compliance_clear=compliance_clear,
        approved_copy_count=approved,
        copy_ge_3=copy_ge_3,
        ok=spec_pass and compliance_clear and copy_ge_3,
    )


# ===========================================================================
# POST /work/pipeline/tools/launch — recorder + HARD gate
# ===========================================================================


class MetaEntity(BaseModel):
    """One operator-created Meta entity to record into ``ad_entity``.

    The operator creates these PAUSED-first via its MCP; we record the ids. We
    DON'T trust an operator-supplied ``state`` to be anything but paused at
    record time (PAUSED-first is enforced server-side, below).
    """

    model_config = {"extra": "allow"}

    kind: str = Field(..., min_length=1)
    meta_id: str = Field(..., min_length=1)
    parent_meta_id: str | None = None
    creative_id: str | None = None
    copy_variant_id: str | None = None
    meta_payload: dict[str, Any] | None = None


class LaunchInput(BaseModel):
    """POST body for ``/work/pipeline/tools/launch``."""

    pipeline_id: str = Field(..., min_length=1)
    # The recorded manager approval — REQUIRED. The hard gate is "an audited
    # human action releases it"; without an approver we refuse to record.
    approved_by: str = Field(..., min_length=1)
    launch_package_id: str | None = None
    client_id: str | None = None
    entities: list[MetaEntity] = Field(..., min_length=1)


@router.post("/work/pipeline/tools/launch", dependencies=[Depends(verify_secret)])
async def record_launch(body: LaunchInput) -> dict[str, Any]:
    """Record an operator launch + enforce the HARD launch gate.

    Order matters: (1) the pipeline must exist; (2) preconditions are re-checked
    SERVER-SIDE and a failing check 422s BEFORE anything is written; (3) the
    ad_entity rows are recorded PAUSED-first and idempotently (re-recording the
    same ``(kind, meta_id)`` updates in place); (4) the ``launch_packages`` gate
    columns are stamped with the approver + frozen preconditions. Returns the
    recorded entity ids + the precondition snapshot.
    """
    observability.bind_pipeline(body.pipeline_id, route="record_launch")

    pipeline = fetch_pipeline(body.pipeline_id)
    if not pipeline:
        raise HTTPException(
            status_code=404, detail=f"pipeline not found: {body.pipeline_id}"
        )

    # Validate entity kinds up front (422 before any write).
    for ent in body.entities:
        if ent.kind not in _AD_ENTITY_KINDS:
            raise HTTPException(
                status_code=422,
                detail=f"invalid ad_entity kind: {ent.kind!r}",
            )

    # (2) HARD gate: re-check preconditions server-side.
    preconditions = check_launch_preconditions(body.pipeline_id)
    if not preconditions.ok:
        log.warning(
            "launch_gate_blocked",
            pipeline_id=body.pipeline_id,
            preconditions=preconditions.as_dict(),
        )
        raise HTTPException(
            status_code=422,
            detail={
                "error": "launch preconditions not met",
                "preconditions": preconditions.as_dict(),
            },
        )

    # (3) Record the entities PAUSED-first, idempotently.
    recorded = _record_ad_entities(
        pipeline_id=body.pipeline_id,
        launch_package_id=body.launch_package_id,
        client_id=body.client_id or pipeline.get("client_id"),
        entities=body.entities,
    )

    # (4) Stamp the launch gate columns (video pipelines -> video_launch_packages).
    _stamp_launch_package(
        launch_package_id=body.launch_package_id,
        pipeline_id=body.pipeline_id,
        approved_by=body.approved_by,
        preconditions=preconditions,
        entities=recorded,
        table=(
            "video_launch_packages"
            if pipeline.get("format_choice") == "video"
            else "launch_packages"
        ),
    )

    # (5) Enqueue the durable Meta launch follow-through in the SAME handler as
    # the state change (the recorder above). Keyed on the pipeline + recorded
    # entity graph so a re-recorded launch (operator retry) does not double-
    # enqueue. The relay performs the exactly-once side effect + retries it.
    enqueue_outbox(
        integration="meta",
        op="record_launch",
        idempotency_key=_launch_idempotency_key(body.pipeline_id, recorded),
        pipeline_id=body.pipeline_id,
        request={
            "pipeline_id": body.pipeline_id,
            "approved_by": body.approved_by,
            "launch_package_id": body.launch_package_id,
            "client_id": body.client_id or pipeline.get("client_id"),
            "entities": [
                {"id": e.get("id"), "kind": e.get("kind"), "meta_id": e.get("meta_id")}
                for e in recorded
            ],
        },
    )

    emit_pipeline_event(
        pipeline_id=body.pipeline_id,
        kind="launch_recorded",
        stage="launch_handoff",
        payload={
            "approved_by": body.approved_by,
            "entity_count": len(recorded),
            "preconditions": preconditions.as_dict(),
        },
    )
    log.info(
        "launch_recorded",
        pipeline_id=body.pipeline_id,
        approved_by=body.approved_by,
        entity_count=len(recorded),
    )
    return {
        "ok": True,
        "pipeline_id": body.pipeline_id,
        "preconditions": preconditions.as_dict(),
        "entities": recorded,
    }


def _record_ad_entities(
    *,
    pipeline_id: str,
    launch_package_id: str | None,
    client_id: Any,
    entities: list[MetaEntity],
) -> list[dict[str, Any]]:
    """Upsert ``ad_entity`` rows PAUSED-first, idempotent on ``(kind, meta_id)``.

    ``unique(kind, meta_id)`` (migration 0022) makes re-recording the same id an
    idempotent operation; we emulate the upsert in two steps (the in-memory
    double + supabase-py both lack ``on_conflict`` here): look up an existing row
    by (kind, meta_id), UPDATE it if present, else INSERT. Always recorded with
    ``state='paused'`` — the operator created it paused and we never flip it live
    (that's the MCP-activate behind the approval gate).
    """
    sb = get_supabase_admin()
    out: list[dict[str, Any]] = []
    for ent in entities:
        existing = (
            sb.table("ad_entity")
            .select("id")
            .eq("kind", ent.kind)
            .eq("meta_id", ent.meta_id)
            .maybe_single()
            .execute()
        )
        existing_row = existing.data if (existing is not None) else None
        row: dict[str, Any] = {
            "pipeline_id": pipeline_id,
            "launch_package_id": launch_package_id,
            "client_id": client_id,
            "kind": ent.kind,
            "meta_id": ent.meta_id,
            "parent_meta_id": ent.parent_meta_id,
            "creative_id": ent.creative_id,
            "copy_variant_id": ent.copy_variant_id,
            "state": "paused",  # PAUSED-first, always.
            "meta_payload": ent.meta_payload or {},
        }
        if isinstance(existing_row, dict) and existing_row.get("id"):
            entity_id = str(existing_row["id"])
            sb.table("ad_entity").update(row).eq("id", entity_id).execute()
            out.append({**row, "id": entity_id, "recorded": "updated"})
        else:
            created = sb.table("ad_entity").insert(row).execute().data
            entity_id = str(created[0]["id"]) if created else None
            out.append({**row, "id": entity_id, "recorded": "inserted"})
    return out


def _stamp_launch_package(
    *,
    launch_package_id: str | None,
    pipeline_id: str,
    approved_by: str,
    preconditions: LaunchPreconditions,
    entities: list[dict[str, Any]],
    table: str = "launch_packages",
) -> None:
    """Stamp the launch gate columns (no-op when no package id).

    ``table`` is ``launch_packages`` (image) or ``video_launch_packages`` (video)
    -- both carry the gate columns (video_launch_packages gained them in 0032).

    Records the approver, the frozen preconditions (so the audit trail shows
    what was true at commit), the campaign meta id, and the recorded entity
    graph. Idempotent: re-stamping the same package overwrites with the same
    values.
    """
    if not launch_package_id:
        return
    sb = get_supabase_admin()
    campaign_id = next(
        (e.get("meta_id") for e in entities if e.get("kind") == "campaign"), None
    )
    sb.table(table).update(
        {
            "pipeline_id": pipeline_id,
            "preconditions": preconditions.as_dict(),
            "approved_by": approved_by,
            "approved_at": _now_iso(),
            "meta_campaign_id": campaign_id,
            "meta_entities": entities,
            "launched_at": _now_iso(),
        }
    ).eq("id", launch_package_id).execute()


# ===========================================================================
# POST /work/pipeline/tools/finalize_drive — record md5-verified Drive URLs
# ===========================================================================


class DriveAsset(BaseModel):
    """One operator-uploaded Drive asset to record + md5-verify."""

    model_config = {"extra": "allow"}

    creative_id: str = Field(..., min_length=1)
    drive_url: str = Field(..., min_length=1)
    drive_folder_id: str | None = None
    asset_name: str | None = None
    # The md5 the operator computed on the bytes it uploaded, and the md5 Drive
    # reported back. We verify they match before stamping ``finalize_verified``.
    expected_md5: str = Field(..., min_length=1)
    drive_md5: str = Field(..., min_length=1)


class FinalizeDriveInput(BaseModel):
    """POST body for ``/work/pipeline/tools/finalize_drive``."""

    pipeline_id: str = Field(..., min_length=1)
    assets: list[DriveAsset] = Field(..., min_length=1)


@router.post(
    "/work/pipeline/tools/finalize_drive", dependencies=[Depends(verify_secret)]
)
async def finalize_drive(body: FinalizeDriveInput) -> dict[str, Any]:
    """Record operator-uploaded Drive URLs, md5-verified, onto creatives.

    For each asset: the operator-supplied ``expected_md5`` must equal the
    ``drive_md5`` Drive reported (a constant-time compare) — a mismatch means a
    corrupt/incomplete upload and 422s the whole batch BEFORE any write (so a
    half-verified finalize never lands). On success we stamp
    ``drive_folder_id`` / ``asset_name`` / ``finalized_at`` /
    ``finalize_verified=true`` on each creative.
    """
    observability.bind_pipeline(body.pipeline_id, route="finalize_drive")

    pipeline = fetch_pipeline(body.pipeline_id)
    if not pipeline:
        raise HTTPException(
            status_code=404, detail=f"pipeline not found: {body.pipeline_id}"
        )

    # Verify EVERY md5 before any write (all-or-nothing).
    for asset in body.assets:
        if not _md5_matches(asset.expected_md5, asset.drive_md5):
            raise HTTPException(
                status_code=422,
                detail={
                    "error": "drive md5 mismatch",
                    "creative_id": asset.creative_id,
                    "expected_md5": asset.expected_md5,
                    "drive_md5": asset.drive_md5,
                },
            )

    sb = get_supabase_admin()
    recorded: list[dict[str, Any]] = []
    now = _now_iso()
    for asset in body.assets:
        update: dict[str, Any] = {
            "drive_folder_id": asset.drive_folder_id,
            "finalized_at": now,
            "finalize_verified": True,
        }
        if asset.asset_name is not None:
            update["asset_name"] = asset.asset_name
        sb.table("creatives").update(update).eq("id", asset.creative_id).execute()
        recorded.append(
            {
                "creative_id": asset.creative_id,
                "drive_url": asset.drive_url,
                "finalize_verified": True,
            }
        )

    # Enqueue the durable Drive finalize follow-through in the same handler as the
    # creative stamps above. Keyed on the pipeline + the verified asset set so a
    # re-finalize (operator retry) does not double-enqueue; the relay performs the
    # exactly-once side effect + retries it.
    enqueue_outbox(
        integration="drive",
        op="finalize_verified",
        idempotency_key=_finalize_idempotency_key(body.pipeline_id, recorded),
        pipeline_id=body.pipeline_id,
        request={
            "pipeline_id": body.pipeline_id,
            "assets": recorded,
        },
    )

    emit_pipeline_event(
        pipeline_id=body.pipeline_id,
        kind="drive_finalized",
        stage="finalize_assets",
        payload={"asset_count": len(recorded)},
    )
    log.info(
        "drive_finalized", pipeline_id=body.pipeline_id, asset_count=len(recorded)
    )
    return {"ok": True, "pipeline_id": body.pipeline_id, "assets": recorded}


def _md5_matches(expected: str, actual: str) -> bool:
    """Constant-time, case-insensitive compare of two md5 hex digests."""
    import hmac

    return hmac.compare_digest(expected.strip().lower(), actual.strip().lower())


def md5_hex(data: bytes) -> str:
    """md5 hex digest of bytes — the helper a caller uses to compute expected_md5."""
    return hashlib.md5(data).hexdigest()  # noqa: S324 — md5 is Drive's checksum, not security


# ===========================================================================
# POST /work/ghl/webhook — ingest GHL lead events, dedupe via inbox
# ===========================================================================


class GhlWebhookInput(BaseModel):
    """Raw GHL webhook body. Free-shape — :func:`parse_webhook_event` typed it."""

    model_config = {"extra": "allow"}


@router.post("/work/ghl/webhook", dependencies=[Depends(verify_secret)])
async def ghl_webhook(body: dict[str, Any]) -> dict[str, Any]:
    """Ingest a GHL contact/opportunity webhook, deduped via the inbox.

    Parses the body into a typed :class:`~services.ghl.WebhookEvent` (a
    malformed body 422s), then writes to ``integration_event_inbox`` keyed on
    the event's deterministic ``dedupe_key`` — a replayed delivery (GHL retries)
    finds the row already present and is dropped (``deduped: true``) so it's
    counted exactly once. New events return ``deduped: false``.
    """
    try:
        event = parse_webhook_event(body)
    except GhlError as e:
        raise HTTPException(status_code=422, detail=f"malformed GHL webhook: {e}")

    sb = get_supabase_admin()
    # Idempotency: probe the inbox by the deterministic key, insert if absent.
    existing = (
        sb.table("integration_event_inbox")
        .select("event_id")
        .eq("provider", "ghl")
        .eq("event_id", event.dedupe_key)
        .maybe_single()
        .execute()
    )
    if existing is not None and isinstance(existing.data, dict):
        log.info("ghl_webhook_deduped", dedupe_key=event.dedupe_key)
        return {
            "ok": True,
            "deduped": True,
            "is_lead": event.is_lead,
            "dedupe_key": event.dedupe_key,
        }

    # Consistent dedupe: the probe above wins the common case, but two concurrent
    # identical deliveries (GHL retries fan in) can both pass it. The inbox PK
    # ``(provider, event_id)`` (migration 0023) is the real backstop -- a racing
    # second insert hits the unique constraint, which we treat as "already
    # ingested" (deduped) rather than 500ing, so the event is still counted once.
    try:
        sb.table("integration_event_inbox").insert(
            {
                "provider": "ghl",
                "event_id": event.dedupe_key,
                "payload": event.raw,
            }
        ).execute()
    except Exception as exc:  # noqa: BLE001 -- PK conflict == already ingested
        log.info(
            "ghl_webhook_deduped_on_conflict",
            dedupe_key=event.dedupe_key,
            error=str(exc),
        )
        return {
            "ok": True,
            "deduped": True,
            "is_lead": event.is_lead,
            "dedupe_key": event.dedupe_key,
        }
    log.info(
        "ghl_webhook_ingested",
        dedupe_key=event.dedupe_key,
        event_type=event.event_type,
        is_lead=event.is_lead,
    )
    return {
        "ok": True,
        "deduped": False,
        "is_lead": event.is_lead,
        "event_type": event.event_type,
        "dedupe_key": event.dedupe_key,
    }


# ===========================================================================
# Daily reconciliation (pure-ish core; cron wiring deferred)
# ===========================================================================


@dataclass(frozen=True)
class ReconciliationResult:
    """Outcome of one pipeline's daily reconciliation."""

    pipeline_id: str
    ghl_leads: int
    meta_spend_usd: float
    real_cpl: float | None
    perf_row_written: bool


async def reconcile_pipeline(
    *,
    pipeline_id: str,
    location_id: str,
    campaign_ref: str,
    window: tuple[datetime, datetime],
    ghl_client: GhlClient,
    ad_entity_id: str | None = None,
    meta_spend_usd: float | None = None,
) -> ReconciliationResult:
    """Reconcile one pipeline: GHL leads vs Meta spend → real CPL → perf row.

    The daily job (#366/#367): count the leads GHL attributes to the campaign in
    the window (GHL is lead truth), determine the pipeline's Meta spend, compute
    ``real_cpl = spend / leads`` (None on zero leads), and write a
    ``campaign_perf_image`` row linked to the pipeline (+ ad_entity).

    E4.3 (#503) fixes the structural ``real_cpl == 0`` bug. Previously this read
    meta_spend ONLY from ``cost_ledger``, but nothing in prod ever RECORDED a
    meta_spend row — so the sum was always 0 and real_cpl was always 0/None and
    the monitor's kill/keep/scale ran on garbage. Now the recorded/pulled Meta
    insights spend (``meta_spend_usd``) is RECORDED to the ledger first (keyed on
    campaign + window so a re-run does not double-count), THEN summed back — so
    the ledger is the single source AND it is actually populated. When
    ``meta_spend_usd`` is None (no insight supplied this pass) we fall back to the
    already-recorded ledger sum, so a re-run without fresh insights still reports
    the prior spend.

    The cron loop over active client_integrations is wired later; this is its
    per-pipeline core, kept as a coroutine so it tests with the GHL connector's
    ``MockTransport`` and the in-memory supabase double, zero live HTTP.
    """
    observability.bind_pipeline(pipeline_id, route="reconcile")
    since, until = window

    leads = await ghl_client.count_leads_for_campaign(
        location_id,
        campaign_ref,
        (since, until),
        correlation_id=pipeline_id,
    )

    # Record the pulled Meta spend onto the ledger BEFORE summing, so the table
    # the budget gauge + this reconciliation read is actually populated. Keyed on
    # (campaign, window) so re-running a day's reconciliation is idempotent.
    if meta_spend_usd is not None and meta_spend_usd > 0:
        cost_ledger.record_meta_spend(
            pipeline_id=pipeline_id,
            amount_usd=float(meta_spend_usd),
            meta={
                "campaign_ref": campaign_ref,
                "window_start": since.isoformat(),
                "window_end": until.isoformat(),
            },
            dedupe_key=_meta_spend_dedupe_key(pipeline_id, campaign_ref, window),
        )

    totals = cost_ledger.sum_costs(pipeline_id)
    meta_spend = totals.meta_spend_usd
    cpl = real_cpl(meta_spend, leads)

    written = _write_campaign_perf(
        pipeline_id=pipeline_id,
        ad_entity_id=ad_entity_id,
        leads=leads,
        meta_spend=meta_spend,
        cpl=cpl,
        window=window,
    )
    log.info(
        "reconciliation_done",
        pipeline_id=pipeline_id,
        leads=leads,
        meta_spend=meta_spend,
        real_cpl=cpl,
    )
    return ReconciliationResult(
        pipeline_id=pipeline_id,
        ghl_leads=leads,
        meta_spend_usd=meta_spend,
        real_cpl=cpl,
        perf_row_written=written,
    )


def _write_campaign_perf(
    *,
    pipeline_id: str,
    ad_entity_id: str | None,
    leads: int,
    meta_spend: float,
    cpl: float | None,
    window: tuple[datetime, datetime],
) -> bool:
    """Insert a ``campaign_perf_image`` row from the reconciliation figures."""
    sb = get_supabase_admin()
    since, until = window
    row: dict[str, Any] = {
        "pipeline_id": pipeline_id,
        "ad_entity_id": ad_entity_id,
        "leads": leads,
        "spend_usd": meta_spend,
        "real_cpl": cpl,
        "window_start": since.isoformat(),
        "window_end": until.isoformat(),
    }
    try:
        sb.table("campaign_perf_image").insert(row).execute()
        return True
    except Exception as e:  # noqa: BLE001 — reconciliation never aborts on a write
        log.warning(
            "campaign_perf_write_failed", pipeline_id=pipeline_id, error=str(e)
        )
        return False


# ===========================================================================
# GET /work/metrics — observability snapshot
# ===========================================================================


@router.get("/work/metrics", dependencies=[Depends(verify_secret)])
async def metrics() -> dict[str, Any]:
    """Observability snapshot: outbox depth, breaker state, dispatches, cost.

    Thin shell over :func:`services.observability.metrics_snapshot`. Breaker
    state is per-process and lives on a connector's resilient client, which is
    not retained across requests here — so the breaker map is exposed as empty
    until the cron-held connector singleton lands (the snapshot shape is stable
    so the dashboard wires to it now). Cost-vs-cap is global here (no cap
    configured ⇒ gauge only), per the architecture's accepted residual.
    """
    sb = get_supabase_admin()
    snapshot = observability.metrics_snapshot(
        sb,
        breaker_states={},
        cost_total_usd=0.0,
        cost_cap_usd=None,
    )
    return snapshot


def _now_iso() -> str:
    """Current UTC time as an ISO-8601 string (Supabase timestamptz friendly)."""
    return datetime.now(timezone.utc).isoformat()


def _launch_idempotency_key(pipeline_id: str, entities: list[dict[str, Any]]) -> str:
    """Deterministic outbox key for a recorded Meta launch.

    Folds the pipeline + the sorted recorded ``(kind, meta_id)`` graph into a
    short stable digest so re-recording the same launch (operator retry) yields
    the same key -- the outbox UNIQUE(idempotency_key) then collapses it to a
    single enqueued side effect.
    """
    graph = sorted(
        f"{e.get('kind')}:{e.get('meta_id')}" for e in entities if e.get("meta_id")
    )
    digest = hashlib.sha256("|".join(graph).encode("utf-8")).hexdigest()[:16]
    return f"meta:record_launch:{pipeline_id}:{digest}"


def _meta_spend_dedupe_key(
    pipeline_id: str, campaign_ref: str, window: tuple[datetime, datetime]
) -> str:
    """Deterministic cost_ledger dedupe key for a recorded Meta spend line.

    Folds the pipeline + campaign + the window bounds into a stable digest so a
    re-run of the same day's reconciliation collapses to one recorded spend row
    (the cost_ledger UNIQUE(dedupe_key) partial index, migration 0036), keeping
    real_cpl correct instead of doubling on every retry.
    """
    since, until = window
    raw = f"{pipeline_id}|{campaign_ref}|{since.isoformat()}|{until.isoformat()}"
    digest = hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16]
    return f"meta_spend:{pipeline_id}:{digest}"


def _finalize_idempotency_key(pipeline_id: str, assets: list[dict[str, Any]]) -> str:
    """Deterministic outbox key for a finalized Drive asset set.

    Folds the pipeline + the sorted finalized ``creative_id`` set into a stable
    digest so re-finalizing the same assets yields the same key (dedupe via the
    outbox UNIQUE constraint).
    """
    ids = sorted(str(a.get("creative_id")) for a in assets if a.get("creative_id"))
    digest = hashlib.sha256("|".join(ids).encode("utf-8")).hexdigest()[:16]
    return f"drive:finalize_verified:{pipeline_id}:{digest}"
