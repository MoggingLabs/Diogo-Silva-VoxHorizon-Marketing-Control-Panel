"""Worker-stage consumer: drains the deterministic ideation/generation kinds.

Silent-failure foundational redesign, PR-8: the cutover (PR-3) removed the
fire-and-forget HTTP kicks the Next routes used to fan at the worker's
deterministic ideation + generation producers, on the premise that "the worker
claims the queued work_item". The matching consumer was never built, so for a
NON-operator-driven pipeline:

  * ``app/api/pipelines/[id]/advance/route.ts`` enqueues a
    ``work_item(kind='worker_ideation')`` and nothing claimed it -> deterministic
    ideation never ran;
  * ``app/api/pipelines/[id]/review/decision/route.ts`` (approve) enqueues a
    ``work_item(kind='worker_generation')`` and nothing claimed it -> finals
    never rendered.

The executor logic still exists in :mod:`routes.pipeline`
(``/work/pipeline/ideation`` + ``/work/pipeline/generation``) but became
unreachable (no caller). This module is the missing drain half. It mirrors the
proven :mod:`services.outbox_consumer` pattern (claim -> dispatch -> close, with
the unified ``run_work_item_watchdog_once`` owning retry / dead-letter) with one
structural difference that the ideation/generation stages force: they are
LONG-RUNNING (each calls Kie + renders), so the consumer cannot claim-and-close
in one tick the way the outbox handlers do. Instead, per claimed row it:

  1. transitions ``claimed -> running`` (mints the first heartbeat) and spawns a
     background heartbeat task so the watchdog does not reclaim the row
     mid-render (mirrors the operator-daemon's per-claim heartbeat task);
  2. dispatches to the in-process stage handler -- which invokes the SAME
     orchestration the route used to (fetch the pipeline, run the idempotency
     probe, await the producers) DIRECTLY in-process (no HTTP self-call);
  3. cancels the heartbeat task and closes the row: ``complete`` on success,
     ``fail`` (classified) on an unexpected exception.

The stage producers themselves are idempotent (they were previously called
fire-and-forget, and each guards on the ``ideation_already_ran`` /
``generation_state`` probe scoped to the latest ``stage_advanced`` event) and
they catch per-creative render failures internally, emitting ``task_error``
pipeline_events rather than raising. So a completed ``worker_*`` work_item means
"the stage producer ran to completion"; whether the pipeline ADVANCES is decided
downstream by the ``pipeline_events`` the producer emitted + the auto-advance
trigger (an all-failed generation stays put -- the documented no-stall guard).
A handler raising is reserved for an UNEXPECTED fault (the pipeline row vanished,
Supabase unreachable): that is a retryable failure the watchdog rotates.

Bounded per pass: one claim per kind per pass mirrors the outbox drainer + the
watchdog rotation budget, so a backlog cannot fan out an unbounded burst of
paid render calls. A per-row failure is logged + classified so one bad row never
aborts the sweep.
"""

from __future__ import annotations

import asyncio
import socket
from collections.abc import Awaitable, Callable
from typing import Any

import structlog

from ..config import Settings
from . import work_queue


log = structlog.get_logger(__name__)


# Stage handler: given the work_item's ``pipeline_id``, run the in-process
# producer orchestration for that stage. Returns a JSON-serialisable result dict
# (stored in ``result``). Raising signals an UNEXPECTED, retryable fault -- the
# row is closed ``failed`` (retryable) and the watchdog rotates it with backoff.
# Per-creative render failures are NOT raised here: the producers emit
# ``task_error`` pipeline_events for those and still return normally, so the
# stage's work_item completes and the auto-advance trigger adjudicates advance.
StageHandler = Callable[[str], Awaitable[dict[str, Any]]]


# ---------------------------------------------------------------------------
# Stage handlers (in-process; no HTTP self-call)
# ---------------------------------------------------------------------------


async def _handle_worker_ideation(pipeline_id: str) -> dict[str, Any]:
    """Run the deterministic ideation producers for a pipeline (in-process).

    Mirrors the orchestration of ``routes.pipeline.run_ideation`` exactly --
    fetch the pipeline, resolve which tracks are active, run the
    ``ideation_already_ran`` idempotency probe -- but AWAITS the producers
    instead of handing them to FastAPI ``BackgroundTasks``, so the work_item is
    only completed once the concepts have actually been produced. The producers
    are imported lazily (``routes.pipeline`` imports ``pipeline_runner`` which
    would otherwise close an import cycle, and the scheduler peers all import
    routes lazily too).

    Raises ``LookupError`` when the pipeline row is missing (an unexpected fault
    the watchdog should rotate, not silently swallow). A per-track / per-concept
    render failure does NOT raise -- the producer catches it and emits a
    ``task_error`` event -- so the stage completes and the timeline carries the
    failure for the dashboard.
    """
    from ..routes.pipeline import (
        _produce_ideation_image_track,
        _produce_ideation_video_track,
    )
    from .pipeline_runner import fetch_pipeline, ideation_already_ran

    pipeline = fetch_pipeline(pipeline_id)
    if pipeline is None:
        raise LookupError(f"pipeline not found: {pipeline_id}")

    format_choice = str(pipeline.get("format_choice") or "image")
    image_brief_id = pipeline.get("image_brief_id")
    video_brief_id = pipeline.get("video_brief_id")
    image_track = format_choice in ("image", "both") and bool(image_brief_id)
    video_track = format_choice in ("video", "both") and bool(video_brief_id)

    # Idempotency: a retried work_item (watchdog requeue) or a duplicate enqueue
    # must not re-produce concepts. The probe scopes to events since the latest
    # stage_advanced->ideation, so a genuine stage re-entry still runs fresh --
    # identical guard to the deleted HTTP route.
    if ideation_already_ran(pipeline_id):
        log.info(
            "worker_stage_ideation_idempotent_skip",
            pipeline_id=pipeline_id,
            format_choice=format_choice,
        )
        return {
            "pipeline_id": pipeline_id,
            "already_run": True,
            "image_track": image_track,
            "video_track": video_track,
        }

    # Run the active tracks. Awaited (not fire-and-forget) so completion of the
    # work_item means the concepts were produced. The tracks are independent;
    # run them concurrently so an image-track latency doesn't serialise behind
    # the video track (the per-brief BriefQueue still serialises Kie within a
    # brief). ``return_exceptions`` keeps one track's unexpected fault from
    # cancelling its peer -- but it IS surfaced (re-raised) so the work_item
    # fails + the watchdog retries rather than silently half-running.
    tasks: list[Awaitable[None]] = []
    if image_track:
        tasks.append(
            _produce_ideation_image_track(
                pipeline_id=pipeline_id, brief_id=str(image_brief_id)
            )
        )
    if video_track:
        tasks.append(
            _produce_ideation_video_track(
                pipeline_id=pipeline_id, brief_id=str(video_brief_id)
            )
        )

    if tasks:
        results = await asyncio.gather(*tasks, return_exceptions=True)
        _reraise_first_exception(results)

    log.info(
        "worker_stage_ideation_done",
        pipeline_id=pipeline_id,
        image_track=image_track,
        video_track=video_track,
    )
    return {
        "pipeline_id": pipeline_id,
        "already_run": False,
        "image_track": image_track,
        "video_track": video_track,
    }


async def _handle_worker_generation(pipeline_id: str) -> dict[str, Any]:
    """Run the deterministic generation producers for a pipeline (in-process).

    Mirrors ``routes.pipeline.run_generation`` -- fetch the pipeline, read the
    picks, run the ``generation_state`` idempotency probe -- but AWAITS the
    image + per-video-pick producers so the work_item completes only when the
    finals have been rendered. Each video pick runs as its own producer
    (matching the route's per-concept fan-out) so one concept's substage
    failure doesn't cancel its peers.

    Raises ``LookupError`` when the pipeline row is missing. A per-creative /
    per-substage render failure does NOT raise (the producers emit
    ``task_error`` and return), so the stage completes and the migration-0024
    auto-advance trigger adjudicates advance vs. the all-failed stay-put guard.
    """
    from ..routes.pipeline import (
        _produce_generation_image_picks,
        _produce_generation_video_pick,
    )
    from .pipeline_runner import fetch_pipeline, generation_state, picks_from_pipeline

    pipeline = fetch_pipeline(pipeline_id)
    if pipeline is None:
        raise LookupError(f"pipeline not found: {pipeline_id}")

    image_picks, video_picks = picks_from_pipeline(pipeline)

    # Idempotency (PF-D-5): the durable pipeline_work_units ledger (else the
    # event-count heuristic) is authoritative. A still-running batch or a
    # successfully-complete batch is a no-op; an all-failed batch is neither, so
    # a retry is free to re-dispatch -- identical guard to the deleted route.
    state = generation_state(pipeline_id)
    if state.already_running:
        log.info(
            "worker_stage_generation_already_running",
            pipeline_id=pipeline_id,
            started_at=state.started_at,
        )
        return {
            "pipeline_id": pipeline_id,
            "already_running": True,
            "image_picks": len(image_picks),
            "video_picks": len(video_picks),
        }
    if state.already_complete:
        log.info(
            "worker_stage_generation_already_complete",
            pipeline_id=pipeline_id,
            started_at=state.started_at,
        )
        return {
            "pipeline_id": pipeline_id,
            "already_complete": True,
            "image_picks": len(image_picks),
            "video_picks": len(video_picks),
        }

    tasks: list[Awaitable[None]] = []
    if image_picks:
        tasks.append(
            _produce_generation_image_picks(
                pipeline_id=pipeline_id, creative_ids=image_picks
            )
        )
    for creative_id in video_picks:
        tasks.append(
            _produce_generation_video_pick(
                pipeline_id=pipeline_id, creative_id=creative_id
            )
        )

    if tasks:
        results = await asyncio.gather(*tasks, return_exceptions=True)
        _reraise_first_exception(results)

    log.info(
        "worker_stage_generation_done",
        pipeline_id=pipeline_id,
        image_picks=len(image_picks),
        video_picks=len(video_picks),
    )
    return {
        "pipeline_id": pipeline_id,
        "already_running": False,
        "already_complete": False,
        "image_picks": len(image_picks),
        "video_picks": len(video_picks),
    }


def _reraise_first_exception(results: list[Any]) -> None:
    """Re-raise the first exception in a ``gather(return_exceptions=True)`` set.

    The producers are run concurrently so a slow track does not serialise
    behind a peer; ``return_exceptions=True`` lets every track finish before we
    decide the work_item's fate. An UNEXPECTED fault in any track (the producers
    do not raise for ordinary per-creative render failures -- those become
    ``task_error`` events) re-raises here so the work_item is failed + the
    watchdog retries, rather than completing a half-run stage silently.
    """
    for result in results:
        if isinstance(result, BaseException):
            raise result


# ---------------------------------------------------------------------------
# Deterministic post-generation gate handlers (FIX-A)
# ---------------------------------------------------------------------------
#
# These are the deterministic-mode dispatch CONSUMERS for the three
# post-generation per-creative gates that previously had no producer (every
# pipeline deadlocked at creative_qa). Each one:
#
#   1. fetches the pipeline (LookupError -> terminal fault, watchdog drops it);
#   2. resolves the in-scope creatives EXACTLY as the auto-advance trigger seeded
#      them -- image: creatives.type='image' AND version like 'v1%' AND
#      deleted_at is null AND status != 'killed'; video: video_creatives.status
#      ='captioned' AND deleted_at is null;
#   3. SKIPs creatives already terminal-good in creative_stage_state(stage)
#      (resume-by-skip-done: a watchdog requeue must not re-adjudicate +
#      double-charge a creative that already passed);
#   4. calls the verdict-writer IN-PROCESS (no HTTP self-call) over the remaining
#      creatives. The verdict-writers (qa_run / compliance_run /
#      persist_spec_result) catch per-creative failures internally (they record a
#      failed/pending verdict + an ``errors`` entry, they do NOT raise), so a bad
#      creative never aborts the batch. Only an UNEXPECTED fault (pipeline row
#      vanished, Supabase unreachable) raises -> the work_item fails + the
#      watchdog rotates it.
#
# Deterministic COPY has NO consumer by design: copy stays manual (a manager
# approves >=3 variants via /copy/decision). Deterministic FINALIZE is likewise
# excluded (a separate pending product decision -- there is no autonomous Drive
# uploader). Operator-mode dispatch for every post-gen stage lives in the Next
# routes + the auto-advance trigger as operator_dispatch work_items.

#: Terminal-good creative_stage_state statuses -- a creative already in one of
#: these for the stage is SKIPPED (resume-by-skip-done). Mirrors the gate
#: predicate's cleared set (lib/pipeline/rollup.ts + the SQL rollup).
_TERMINAL_GOOD_STAGE_STATES: frozenset[str] = frozenset(
    {"passed", "overridden", "skipped"}
)


def _resolve_in_scope_creatives(
    sb: Any, pipeline: dict[str, Any]
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Return ``(image_creatives, video_creatives)`` in scope for the gates.

    Resolved EXACTLY as ``pipeline_events_auto_advance_done()`` (migration 0053b)
    seeded the creative_qa gate rows, so the deterministic consumer adjudicates
    the same set the gate predicate later reads:

      * image -- ``creatives`` where ``brief_id = image_brief_id`` AND
        ``type='image'`` AND ``version like 'v1%'`` AND ``deleted_at is null``
        AND ``status != 'killed'`` (a killed creative drops out of scope);
      * video -- ``video_creatives`` where ``brief_id = video_brief_id`` AND
        ``status='captioned'`` AND ``deleted_at is null``.

    Returns the rows (dicts with at least ``id``) for each active track; an
    inactive track returns an empty list.
    """
    image_brief_id = pipeline.get("image_brief_id")
    video_brief_id = pipeline.get("video_brief_id")
    format_choice = str(pipeline.get("format_choice") or "image")
    image_track = format_choice in ("image", "both") and bool(image_brief_id)
    video_track = format_choice in ("video", "both") and bool(video_brief_id)

    image_rows: list[dict[str, Any]] = []
    if image_track:
        resp = (
            sb.table("creatives")
            .select("id, status, file_path_supabase")
            .eq("brief_id", str(image_brief_id))
            .eq("type", "image")
            .like("version", "v1%")
            .is_("deleted_at", "null")
            .execute()
        )
        rows = resp.data if (resp is not None and isinstance(resp.data, list)) else []
        image_rows = [
            r for r in rows if isinstance(r, dict) and r.get("status") != "killed"
        ]

    video_rows: list[dict[str, Any]] = []
    if video_track:
        resp = (
            sb.table("video_creatives")
            .select("id, status")
            .eq("brief_id", str(video_brief_id))
            .eq("status", "captioned")
            .is_("deleted_at", "null")
            .execute()
        )
        rows = resp.data if (resp is not None and isinstance(resp.data, list)) else []
        video_rows = [r for r in rows if isinstance(r, dict) and r.get("id")]

    return image_rows, video_rows


def _already_terminal_good(sb: Any, *, creative_id: str, stage: str) -> bool:
    """True iff the creative's gate state for ``stage`` is already terminal-good.

    Resume-by-skip-done: a watchdog requeue (or a duplicate dispatch) must not
    re-adjudicate a creative that already passed -- re-running QA / compliance
    would re-download + re-probe + potentially re-charge. A row in
    ``passed | overridden | skipped`` is skipped; a ``pending`` / ``failed`` /
    ``in_progress`` row (or no row) is (re)adjudicated.
    """
    resp = (
        sb.table("creative_stage_state")
        .select("status")
        .eq("creative_id", creative_id)
        .eq("stage", stage)
        .maybe_single()
        .execute()
    )
    row = resp.data if (resp is not None and isinstance(resp.data, dict)) else None
    return bool(row) and row.get("status") in _TERMINAL_GOOD_STAGE_STATES


async def _handle_worker_qa(pipeline_id: str) -> dict[str, Any]:
    """Deterministic creative_qa: fan ``qa_run`` over the in-scope creatives.

    Imports the worker-owned ``qa_run`` verdict-writer in-process (NOT over HTTP)
    and calls it once with a batch of the not-yet-passed creatives. The writer
    fetches the bytes (image) or probes the MP4 (video), runs the deterministic
    backstops, adjudicates, and rolls ``creative_stage_state(creative_qa)`` per
    creative; per-creative failures land in its ``errors`` list, never as a
    raise. Raises ``LookupError`` only when the pipeline row is gone.
    """
    from ..routes.qa_compliance import QAItem, QARunInput, qa_run
    from .pipeline_runner import fetch_pipeline

    pipeline = fetch_pipeline(pipeline_id)
    if pipeline is None:
        raise LookupError(f"pipeline not found: {pipeline_id}")

    sb = _sb_for_handler()
    image_rows, video_rows = _resolve_in_scope_creatives(sb, pipeline)

    items: list[QAItem] = []
    for r in image_rows:
        cid = str(r["id"])
        if _already_terminal_good(sb, creative_id=cid, stage="creative_qa"):
            continue
        items.append(QAItem(creative_id=cid, surface="image"))
    for r in video_rows:
        cid = str(r["id"])
        if _already_terminal_good(sb, creative_id=cid, stage="creative_qa"):
            continue
        items.append(QAItem(creative_id=cid, surface="video"))

    if not items:
        log.info("worker_stage_qa_nothing_to_do", pipeline_id=pipeline_id)
        return {"pipeline_id": pipeline_id, "adjudicated": 0, "skipped_all": True}

    result = await qa_run(QARunInput(pipeline_id=pipeline_id, items=items))
    log.info(
        "worker_stage_qa_done",
        pipeline_id=pipeline_id,
        adjudicated=len(result.get("results", [])),
        errors=len(result.get("errors", [])),
        rollup=result.get("rollup"),
    )
    return {
        "pipeline_id": pipeline_id,
        "stage": "creative_qa",
        "adjudicated": len(result.get("results", [])),
        "errors": len(result.get("errors", [])),
        "rollup": result.get("rollup"),
    }


async def _handle_worker_compliance(pipeline_id: str) -> dict[str, Any]:
    """Deterministic compliance_review: fan ``compliance_run`` (rules only).

    Calls the worker-owned ``compliance_run`` verdict-writer in-process with
    EMPTY ``llm_candidates`` for each not-yet-passed creative -- the deterministic
    compliance engine still applies its rules-as-data ruleset (the operator's LLM
    candidates are an ADD-ON, not a precondition). The writer rolls
    ``creative_stage_state(compliance_review)`` per creative; a block-severity
    finding fails the unit (the HARD gate). Raises ``LookupError`` only when the
    pipeline row is gone.
    """
    from ..routes.qa_compliance import ComplianceItem, ComplianceRunInput, compliance_run
    from .pipeline_runner import fetch_pipeline

    pipeline = fetch_pipeline(pipeline_id)
    if pipeline is None:
        raise LookupError(f"pipeline not found: {pipeline_id}")

    sb = _sb_for_handler()
    image_rows, video_rows = _resolve_in_scope_creatives(sb, pipeline)

    items: list[ComplianceItem] = []
    for r in image_rows:
        cid = str(r["id"])
        if _already_terminal_good(sb, creative_id=cid, stage="compliance_review"):
            continue
        items.append(ComplianceItem(creative_id=cid, surface="image", llm_candidates=[]))
    for r in video_rows:
        cid = str(r["id"])
        if _already_terminal_good(sb, creative_id=cid, stage="compliance_review"):
            continue
        items.append(ComplianceItem(creative_id=cid, surface="video", llm_candidates=[]))

    if not items:
        log.info("worker_stage_compliance_nothing_to_do", pipeline_id=pipeline_id)
        return {"pipeline_id": pipeline_id, "adjudicated": 0, "skipped_all": True}

    result = await compliance_run(
        ComplianceRunInput(pipeline_id=pipeline_id, items=items)
    )
    log.info(
        "worker_stage_compliance_done",
        pipeline_id=pipeline_id,
        adjudicated=len(result.get("results", [])),
        errors=len(result.get("errors", [])),
        rollup=result.get("rollup"),
    )
    return {
        "pipeline_id": pipeline_id,
        "stage": "compliance_review",
        "adjudicated": len(result.get("results", [])),
        "errors": len(result.get("errors", [])),
        "rollup": result.get("rollup"),
    }


#: Deterministic-mode default placement for the spec gate. The spec verdict
#: writer keys derived crops off (platform, placement); ``feed`` is the
#: universal Meta placement every creative validates against. The worker spec
#: backstop recomputes VIDEO placements from the real asset (and can only
#: tighten the verdict); image creatives keep this ``pass`` (the qa_run route is
#: the worker-owned image backstop).
_DETERMINISTIC_SPEC_PLATFORM = "meta"
_DETERMINISTIC_SPEC_PLACEMENT = "feed"


async def _handle_worker_spec(pipeline_id: str) -> dict[str, Any]:
    """Deterministic spec_validation: fan ``persist_spec_result`` per creative.

    Calls the worker-owned ``persist_spec_result`` verdict-writer in-process with
    one ``feed`` placement per not-yet-passed creative. For a VIDEO creative the
    writer's worker backstop downloads the asset, probes it, and DOWNGRADES the
    submitted ``pass`` to ``fail`` when the asset violates the placement spec --
    the operator (or here, the deterministic submission) can never pass a
    non-conformant asset. Image creatives keep the ``pass``. Rolls
    ``creative_stage_state(spec_validation)`` per creative. Raises ``LookupError``
    only when the pipeline row is gone.
    """
    from ..routes.operator_stage_tools import SpecInput, SpecResult, persist_spec_result
    from .pipeline_runner import fetch_pipeline

    pipeline = fetch_pipeline(pipeline_id)
    if pipeline is None:
        raise LookupError(f"pipeline not found: {pipeline_id}")

    sb = _sb_for_handler()
    image_rows, video_rows = _resolve_in_scope_creatives(sb, pipeline)

    results: list[SpecResult] = []
    for r in [*image_rows, *video_rows]:
        cid = str(r["id"])
        if _already_terminal_good(sb, creative_id=cid, stage="spec_validation"):
            continue
        results.append(
            SpecResult(
                creative_id=cid,
                platform=_DETERMINISTIC_SPEC_PLATFORM,
                placement=_DETERMINISTIC_SPEC_PLACEMENT,
                status="pass",
                checks={"source": "deterministic_worker_spec"},
            )
        )

    if not results:
        log.info("worker_stage_spec_nothing_to_do", pipeline_id=pipeline_id)
        return {"pipeline_id": pipeline_id, "adjudicated": 0, "skipped_all": True}

    result = await persist_spec_result(
        SpecInput(pipeline_id=pipeline_id, results=results)
    )
    log.info(
        "worker_stage_spec_done",
        pipeline_id=pipeline_id,
        placements=len(result.get("results", [])),
        creatives=len(result.get("rollup", [])),
    )
    return {
        "pipeline_id": pipeline_id,
        "stage": "spec_validation",
        "placements": len(result.get("results", [])),
        "creatives": len(result.get("rollup", [])),
    }


def _sb_for_handler() -> Any:
    """The service-role supabase client the deterministic handlers read with.

    The verdict-writers call ``get_supabase_admin()`` themselves for their
    writes; the handlers need the same client for the in-scope-creative
    resolution + the skip-done probe. Lazily imported to mirror the peer
    handlers (which import ``pipeline_runner`` lazily to avoid an import cycle).
    """
    from ..supabase_client import get_supabase_admin

    return get_supabase_admin()


async def _handle_worker_monitor(pipeline_id: str) -> dict[str, Any]:
    """Acknowledge a terminal monitor verdict (no-op shell -- see PR-8 report).

    The monitor decision route (``monitor/decision``) enqueues a
    ``worker_monitor`` row to forward the operator's kill/scale verdict to the
    worker. The actual ACTION -- pausing the Meta entities on ``kill`` or bumping
    the budget on ``scale`` -- was NEVER implemented as a worker service (the old
    route fire-and-forgot at a ``/work/pipeline/monitor`` endpoint that does not
    exist; the 404 was swallowed). Rather than INVENT that side effect here, this
    handler is a no-op acknowledgement shell -- IDENTICAL in spirit to the outbox
    handlers (``services.outbox_consumer``), which also acknowledge an
    operator-held MCP follow-through they do not yet perform.

    Why a no-op shell and not a stranded queued row: leaving ``worker_monitor``
    unhandled would recreate the very silent-failure this PR fixes (a row queued
    forever with no consumer). Acknowledging it closes the row ``completed`` so
    the verdict is TRACKED + VISIBLE on the dashboard, and the real Meta-pause /
    budget write drops in here as a one-function change. The monitor stage is
    terminal best-effort (the pipeline already reached ``done``), so an
    acknowledgement is the honest terminal state until that connector lands.
    """
    log.info("worker_stage_monitor_acknowledged", pipeline_id=pipeline_id)
    return {"pipeline_id": pipeline_id, "acknowledged": True}


# Per-kind dispatch table. A new deterministic worker stage wires here.
_HANDLERS: dict[str, StageHandler] = {
    "worker_ideation": _handle_worker_ideation,
    "worker_generation": _handle_worker_generation,
    "worker_monitor": _handle_worker_monitor,
    # FIX-A: deterministic post-generation gate consumers (the missing
    # producers that left every pipeline deadlocked at creative_qa).
    "worker_qa": _handle_worker_qa,
    "worker_compliance": _handle_worker_compliance,
    "worker_spec": _handle_worker_spec,
}


# ---------------------------------------------------------------------------
# Drain pass
# ---------------------------------------------------------------------------


def _consumer_id() -> str:
    """Stable consumer identifier (one per worker host).

    Mirrors :func:`services.outbox_consumer._consumer_id`. The work_item
    ``claimed_by`` records who holds a row; the hostname (with a stable prefix)
    lets the dashboard surface the draining worker and keeps two worker replicas
    from appearing as the same consumer to the watchdog.
    """
    host = socket.gethostname() or "unknown"
    return f"worker-stage-{host}"


async def _heartbeat_until_cancelled(
    sb: Any,
    *,
    work_item_id: str,
    claim_token: str,
    interval_s: float,
    on_token_rotated: asyncio.Event,
) -> None:
    """Bump ``heartbeat_at`` every ``interval_s`` until cancelled.

    Mirrors the operator-daemon's per-claim heartbeat task: while the stage
    producer runs (possibly minutes), this keeps the row's heartbeat fresh so
    the watchdog does not classify it stale and rotate the claim mid-render. A
    token-scoped heartbeat that hits 0 rows means the watchdog ALREADY rotated
    us (we stalled past the threshold before the first beat, or a prior beat
    was delayed); we set ``on_token_rotated`` so the drain loop knows not to
    close the row (the watchdog owns it now) and stop beating. The task is
    cancelled by the drain loop the moment the producer returns.
    """
    while True:
        try:
            await asyncio.sleep(interval_s)
        except asyncio.CancelledError:
            raise
        try:
            ok = work_queue.heartbeat_work_item(
                sb, work_item_id=work_item_id, claim_token=claim_token
            )
        except Exception as exc:  # noqa: BLE001 -- a transient beat failure is not fatal
            # A Supabase blip on one beat must not kill the run; the next beat
            # retries. Only a definitive token rotation (0 rows) aborts.
            log.warning(
                "worker_stage_heartbeat_failed",
                work_item_id=work_item_id,
                error=str(exc),
            )
            continue
        if not ok:
            log.warning(
                "worker_stage_heartbeat_token_rotated",
                work_item_id=work_item_id,
            )
            on_token_rotated.set()
            return


def _classify_failure(exc: BaseException) -> tuple[str, bool]:
    """Map an unexpected stage fault to ``(error_kind, retryable)``.

    ``LookupError`` (the pipeline row vanished) is TERMINAL: retrying cannot
    bring the row back, so it dead-letters immediately rather than burning the
    retry budget. Everything else (Supabase blip, an unexpected producer crash)
    is treated as retryable so the watchdog rotates it with backoff -- the
    conservative default, matching how the outbox path leaves a raised handler
    for the watchdog.
    """
    if isinstance(exc, LookupError):
        return "pipeline_not_found", False
    return "stage_execution_error", True


async def _drain_one(
    sb: Any,
    *,
    kind: str,
    handler: StageHandler,
    consumer: str,
    heartbeat_interval_s: float,
) -> bool:
    """Claim + run + close one due row of ``kind``. Returns True iff completed.

    The long-running half of the drainer: claim atomically, transition the row
    to ``running`` (mint the first heartbeat) + spawn the heartbeat task,
    dispatch to the in-process handler, then close (complete on success;
    classified fail on an unexpected fault). All closes are token-scoped so a
    watchdog rotation mid-run leaves us a no-op.
    """
    try:
        row = work_queue.claim_work_item(sb, kind=kind, consumer=consumer)
    except Exception as exc:  # noqa: BLE001 -- one bad claim never sinks the pass
        log.warning("worker_stage_claim_failed", kind=kind, error=str(exc))
        return False
    if row is None:
        return False

    work_item_id = str(row.get("id") or "")
    claim_token = row.get("claim_token")
    pipeline_id = row.get("pipeline_id")
    if not work_item_id or not claim_token or not pipeline_id:
        # The claim RPC should never return a row missing an id / token, and the
        # worker_* kinds are always pipeline-scoped (the routes enqueue them with
        # a pipeline_id). A malformed row is left held for the watchdog rather
        # than risk a bad dispatch.
        log.warning(
            "worker_stage_claim_malformed",
            kind=kind,
            row_id=work_item_id,
            has_token=bool(claim_token),
            has_pipeline=bool(pipeline_id),
        )
        return False
    claim_token = str(claim_token)
    pipeline_id = str(pipeline_id)

    # Transition claimed -> running so the row carries a heartbeat before the
    # (long) producer starts; the watchdog's stuck check uses heartbeat_at.
    if not work_queue.heartbeat_work_item(
        sb, work_item_id=work_item_id, claim_token=claim_token
    ):
        # The watchdog rotated us between claim and the first heartbeat; abort.
        log.warning(
            "worker_stage_initial_heartbeat_token_rotated",
            kind=kind,
            work_item_id=work_item_id,
        )
        return False

    rotated = asyncio.Event()
    hb_task = asyncio.create_task(
        _heartbeat_until_cancelled(
            sb,
            work_item_id=work_item_id,
            claim_token=claim_token,
            interval_s=heartbeat_interval_s,
            on_token_rotated=rotated,
        ),
        name=f"worker-stage-heartbeat-{work_item_id}",
    )

    try:
        result = await handler(pipeline_id)
    except BaseException as exc:  # noqa: BLE001 -- classify + close, never leak
        hb_task.cancel()
        try:
            await hb_task
        except (asyncio.CancelledError, Exception):  # noqa: BLE001
            pass
        if rotated.is_set():
            # The watchdog already owns the row; do not double-close.
            log.warning(
                "worker_stage_failed_after_rotation",
                kind=kind,
                work_item_id=work_item_id,
            )
            return False
        error_kind, retryable = _classify_failure(exc)
        log.warning(
            "worker_stage_handler_failed",
            kind=kind,
            work_item_id=work_item_id,
            pipeline_id=pipeline_id,
            error_kind=error_kind,
            retryable=retryable,
            error=str(exc),
        )
        work_queue.fail_work_item(
            sb,
            work_item_id=work_item_id,
            claim_token=claim_token,
            error_kind=error_kind,
            error_detail={"error": str(exc)[:500], "kind": kind},
            retryable=retryable,
        )
        return False

    # Producer ran to completion; stop the heartbeat before the terminal close.
    hb_task.cancel()
    try:
        await hb_task
    except (asyncio.CancelledError, Exception):  # noqa: BLE001
        pass
    if rotated.is_set():
        log.warning(
            "worker_stage_complete_after_rotation",
            kind=kind,
            work_item_id=work_item_id,
        )
        return False

    closed = work_queue.complete_work_item(
        sb,
        work_item_id=work_item_id,
        claim_token=claim_token,
        result=result if isinstance(result, dict) else None,
    )
    if not closed:
        log.warning(
            "worker_stage_complete_token_rotated",
            kind=kind,
            work_item_id=work_item_id,
        )
        return False

    log.info(
        "worker_stage_completed",
        kind=kind,
        work_item_id=work_item_id,
        pipeline_id=pipeline_id,
    )
    return True


async def run_worker_stage_drain_once(
    settings: Settings,
    *,
    kinds: list[str],
    sb: Any | None = None,
) -> dict[str, int]:
    """One bounded pass of the worker-stage drainer. Returns a per-kind tally.

    For each kind in ``kinds``: claim one due row, transition it to ``running``
    under a live heartbeat, run the in-process stage producer to completion, and
    close the row (complete on success; classified fail on an unexpected fault
    so the watchdog rotates it). Returns ``{kind: rows_completed}``; a kind with
    nothing due reports 0. One claim per kind per pass bounds the paid-render
    fan-out. A per-row failure is logged + classified so one bad row never
    aborts the sweep.
    """
    if sb is None:
        from ..supabase_client import get_supabase_admin  # lazy: mirror peers

        sb = get_supabase_admin()

    consumer = _consumer_id()
    interval_s = float(settings.work_item_consumer_heartbeat_s)
    tally: dict[str, int] = {kind: 0 for kind in kinds}

    for kind in kinds:
        handler = _HANDLERS.get(kind)
        if handler is None:
            log.warning("worker_stage_drain_no_handler", kind=kind)
            continue
        completed = await _drain_one(
            sb,
            kind=kind,
            handler=handler,
            consumer=consumer,
            heartbeat_interval_s=interval_s,
        )
        if completed:
            tally[kind] += 1

    log.info("worker_stage_drain_pass_done", tally=tally)
    return tally


__all__ = [
    "StageHandler",
    "run_worker_stage_drain_once",
]
