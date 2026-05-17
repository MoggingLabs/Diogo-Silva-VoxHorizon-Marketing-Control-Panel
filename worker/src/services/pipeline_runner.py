"""Pipeline orchestration helpers.

The ``/work/pipeline/ideation`` and ``/work/pipeline/generation`` routes
both fan out a lot of work in the background after a thin synchronous
HTTP reply. This module holds the helpers that those routes share so the
route file stays mostly fetch + validate + dispatch.

Three categories live here:

1. **Pipeline event emission** (``emit_pipeline_event``) — append-only
   timeline write. Used by both ideation and generation to surface
   ``task_queued`` / ``task_running`` / ``task_done`` / ``task_error`` /
   ``cost_recorded`` rows for the UI realtime subscription.

2. **Idempotency probes** (``ideation_already_ran`` /
   ``generation_state``). The two endpoints are fire-and-forget from the
   Next.js advance route, so a second click during the same run must
   *not* re-trigger the worker. Both probes scope to events emitted
   *since the latest* ``stage_advanced→<stage>`` row so re-running the
   stage (e.g. after a manual stage rewind) starts fresh.

3. **Pipeline fetch / sanity helpers** — small wrappers around Supabase
   reads that the route layer would otherwise duplicate.

The route layer wires these together with FastAPI's ``BackgroundTasks``
to keep the HTTP response < 100 ms while the producer work happens in a
background coroutine.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal

import structlog

from ..supabase_client import get_supabase_admin


log = structlog.get_logger(__name__)


# Event "kind" strings used by the pipeline timeline. Kept here as plain
# constants (not an enum) because the database column is free-form text
# and the front-end already keys off the same string literals — see
# ``lib/pipeline/types.ts``.
EVENT_TASK_QUEUED = "task_queued"
EVENT_TASK_RUNNING = "task_running"
EVENT_TASK_DONE = "task_done"
EVENT_TASK_ERROR = "task_error"
EVENT_COST_RECORDED = "cost_recorded"
EVENT_STAGE_ADVANCED = "stage_advanced"

# Set of "terminal" kinds. A task is considered terminal when it reaches
# either of these — used by the generation idempotency probe to decide
# whether prior runs are still in flight or have fully resolved.
_TERMINAL_KINDS = {EVENT_TASK_DONE, EVENT_TASK_ERROR}
_NON_TERMINAL_TASK_KINDS = {EVENT_TASK_QUEUED, EVENT_TASK_RUNNING}


PipelineStage = Literal[
    "configuration", "ideation", "review", "generation", "done", "cancelled"
]


# ---------------------------------------------------------------------------
# Event emission
# ---------------------------------------------------------------------------


def emit_pipeline_event(
    *,
    pipeline_id: str,
    kind: str,
    stage: PipelineStage | None,
    payload: dict[str, Any] | None = None,
) -> str | None:
    """Insert one row into ``pipeline_events`` and return the new id.

    Failures are logged (so the operator can see them in structlog
    output) but never raise — the timeline is a denormalized audit log,
    not the source of truth. The pipeline row itself is what the
    state-machine reads from. Returning ``None`` on failure lets callers
    that want to nest events (e.g. emit a ``cost_recorded`` referencing
    the prior ``task_done``) detect the failure and skip the follow-up.
    """
    sb = get_supabase_admin()
    try:
        resp = (
            sb.table("pipeline_events")
            .insert(
                {
                    "pipeline_id": pipeline_id,
                    "kind": kind,
                    "stage": stage,
                    "payload": payload or {},
                }
            )
            .execute()
        )
        row = (resp.data or [None])[0]
        if isinstance(row, dict):
            return str(row.get("id") or "") or None
    except Exception as e:  # noqa: BLE001
        log.warning(
            "pipeline_event_emit_failed",
            pipeline_id=pipeline_id,
            kind=kind,
            stage=stage,
            error=str(e),
        )
    return None


# ---------------------------------------------------------------------------
# Idempotency probes
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class StageEvents:
    """Slice of ``pipeline_events`` since a stage entered the pipeline."""

    stage_advanced_at: str | None
    """ISO timestamp of the most recent ``stage_advanced→<stage>`` event,
    or ``None`` when the stage was never entered."""

    non_terminal_task_kinds: list[str]
    """Kinds (``task_queued`` / ``task_running``) seen since the stage
    advance that have NOT been balanced by a matching ``task_done`` /
    ``task_error``. A non-empty list means "work is still in flight."""

    task_done_count: int
    """How many ``task_done`` events have fired since the stage advance."""

    task_error_count: int
    """How many ``task_error`` events have fired since the stage advance."""

    any_task_event: bool
    """True if ANY task-shaped event (queued/running/done/error) exists
    since the stage advance — used as the "already ran" signal for
    ideation, which doesn't need the per-task balancing logic."""


def fetch_stage_events(*, pipeline_id: str, stage: PipelineStage) -> StageEvents:
    """Summarise pipeline events scoped to the latest entry into ``stage``.

    The query strategy is intentionally simple:
      1. Pull the most recent ``stage_advanced`` event for this stage.
         Its ``created_at`` is the cutoff timestamp.
      2. Pull all events created strictly after that cutoff.
      3. Bucket by ``kind`` and return a summary.

    No window functions or RPC needed — pipeline timelines are bounded
    (a handful of events per stage) so two indexed selects are fine.
    """
    sb = get_supabase_admin()

    # 1. Find the latest stage_advanced event for this stage.
    adv_resp = (
        sb.table("pipeline_events")
        .select("id, created_at")
        .eq("pipeline_id", pipeline_id)
        .eq("kind", EVENT_STAGE_ADVANCED)
        .eq("stage", stage)
        .order("created_at", desc=True)
        .limit(1)
        .execute()
    )
    rows = adv_resp.data or []
    if not rows:
        # Stage was never entered — treat as "nothing has run".
        return StageEvents(
            stage_advanced_at=None,
            non_terminal_task_kinds=[],
            task_done_count=0,
            task_error_count=0,
            any_task_event=False,
        )
    cutoff_iso: str = str(rows[0]["created_at"])

    # 2. Pull every event since the cutoff. Filter by `gt` on created_at
    # rather than copying the cutoff id, because Postgres timestamp
    # comparisons are cheap on the indexed column.
    ev_resp = (
        sb.table("pipeline_events")
        .select("kind, payload, created_at")
        .eq("pipeline_id", pipeline_id)
        .gt("created_at", cutoff_iso)
        .order("created_at", desc=False)
        .execute()
    )

    queued = 0
    running = 0
    done = 0
    err = 0
    any_task = False
    for row in ev_resp.data or []:
        kind = str(row.get("kind") or "")
        if kind in _NON_TERMINAL_TASK_KINDS or kind in _TERMINAL_KINDS:
            any_task = True
        if kind == EVENT_TASK_QUEUED:
            queued += 1
        elif kind == EVENT_TASK_RUNNING:
            running += 1
        elif kind == EVENT_TASK_DONE:
            done += 1
        elif kind == EVENT_TASK_ERROR:
            err += 1

    # "non-terminal" means queued+running outweigh done+error. We can't
    # match queued↔done pairs without an explicit task id; the count
    # comparison is good enough for the idempotency guard.
    non_terminal: list[str] = []
    open_count = max(0, (queued + running) - (done + err))
    if open_count > 0:
        # Surface the kinds for diagnostics; the route only checks
        # truthiness so the exact ordering doesn't matter.
        if running > done + err:
            non_terminal.append(EVENT_TASK_RUNNING)
        if queued > done + err:
            non_terminal.append(EVENT_TASK_QUEUED)

    return StageEvents(
        stage_advanced_at=cutoff_iso,
        non_terminal_task_kinds=non_terminal,
        task_done_count=done,
        task_error_count=err,
        any_task_event=any_task,
    )


def ideation_already_ran(pipeline_id: str) -> bool:
    """True if the latest entry into ``ideation`` has already produced events.

    Ideation produces N image concepts + N video drafts in one shot; a
    second click during the same stage entry must not duplicate them.
    We treat *any* task-shaped event after the latest
    ``stage_advanced→ideation`` as "the producer already ran".
    """
    snapshot = fetch_stage_events(pipeline_id=pipeline_id, stage="ideation")
    return snapshot.any_task_event


@dataclass(frozen=True)
class GenerationState:
    """Idempotency outcome for ``/work/pipeline/generation``."""

    already_running: bool
    """True if any non-terminal task events exist since the latest
    ``stage_advanced→generation``. The route returns 200 with
    ``already_running: true`` and skips the producer."""

    already_complete: bool
    """True if at least one task event exists since the latest stage
    advance AND every task event is terminal. The route returns 200 with
    ``already_complete: true``."""

    started_at: str | None
    """The ``stage_advanced→generation`` timestamp, surfaced so the
    front-end can show "started 12 minutes ago"."""


def generation_state(pipeline_id: str) -> GenerationState:
    """Compute the idempotency state for the generation endpoint."""
    snapshot = fetch_stage_events(pipeline_id=pipeline_id, stage="generation")
    running = bool(snapshot.non_terminal_task_kinds)
    complete = snapshot.any_task_event and not running
    return GenerationState(
        already_running=running,
        already_complete=complete,
        started_at=snapshot.stage_advanced_at,
    )


# ---------------------------------------------------------------------------
# Pipeline row helpers
# ---------------------------------------------------------------------------


def fetch_pipeline(pipeline_id: str) -> dict[str, Any] | None:
    """Pull the pipeline row by id. Returns ``None`` when missing.

    The route layer raises 404; this helper stays None-returning so
    callers in tests don't have to mock an exception path.
    """
    sb = get_supabase_admin()
    resp = (
        sb.table("pipelines")
        .select(
            "id, status, format_choice, client_id, image_brief_id, "
            "video_brief_id, config_draft, picks, advanced_at, created_at"
        )
        .eq("id", pipeline_id)
        .maybe_single()
        .execute()
    )
    row = resp.data
    if isinstance(row, dict):
        return row
    return None


def picks_from_pipeline(pipeline: dict[str, Any]) -> tuple[list[str], list[str]]:
    """Read ``pipeline.picks`` into (image_ids, video_ids) tuples.

    ``pipeline.picks`` is a jsonb of the shape::

        { "image": ["uuid", ...], "video": ["uuid", ...] }

    Either key may be missing when the pipeline doesn't use that track.
    Non-string entries are filtered out defensively — the operator picks
    are written by the UI but we don't want a stray ``null`` to crash
    the producer.
    """
    raw = pipeline.get("picks")
    if not isinstance(raw, dict):
        return [], []

    image_raw = raw.get("image") or []
    video_raw = raw.get("video") or []
    image_ids = [str(x) for x in image_raw if isinstance(x, str) and x]
    video_ids = [str(x) for x in video_raw if isinstance(x, str) and x]
    return image_ids, video_ids


# ---------------------------------------------------------------------------
# Cost recording
# ---------------------------------------------------------------------------


def emit_cost(
    *,
    pipeline_id: str,
    api: str,
    units: int | float,
    subtotal: float,
    task_event_id: str | None = None,
    stage: PipelineStage = "generation",
    extra: dict[str, Any] | None = None,
) -> None:
    """Emit a ``cost_recorded`` pipeline event after a paid external call.

    ``api`` identifies the upstream (``"kie.ai"``, ``"elevenlabs"``,
    ``"submagic"``). ``units`` is API-specific (image count, character
    count, video minutes). ``subtotal`` is in USD. The aggregator in PF-F
    sums these into ``pipelines.cost_actual``.
    """
    payload: dict[str, Any] = {
        "api": api,
        "units": units,
        "subtotal": subtotal,
    }
    if task_event_id:
        payload["task_event_id"] = task_event_id
    if extra:
        payload["extra"] = extra
    emit_pipeline_event(
        pipeline_id=pipeline_id,
        kind=EVENT_COST_RECORDED,
        stage=stage,
        payload=payload,
    )
