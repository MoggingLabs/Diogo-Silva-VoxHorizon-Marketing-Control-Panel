"""Periodic background scheduler for the worker's cron cores (#354).

The pipeline rebuild shipped three *pure* cores with their cron wiring
deliberately deferred (each module says so in its docstring / WIRING_NOTE):

  1. the **stuck-dispatch watchdog** -- re-dispatch wedged operator runs
     (:func:`services.operator_dispatch_watchdog.find_stuck_dispatches`);
  2. the **GHL daily reconciliation** -- real CPL = Meta spend / GHL leads
     (:func:`routes.integrations.reconcile_pipeline`);
  3. the **observability watchdogs** -- flag stuck dispatches + stuck outbox
     rows for alerting (:func:`services.observability.stuck_dispatches` /
     :func:`~services.observability.stuck_outbox`).

This module is the missing scheduling half. It follows the pattern already in
the worker (``asyncio.create_task`` + ``asyncio.sleep`` loops -- see
:mod:`services.hermes_approval`) rather than adding an APScheduler dependency:
the worker has no scheduler dep today and the team prefers staying
dependency-light. Each job runs in its own supervised loop; every tick is
wrapped so a job failure is logged and the loop sleeps and retries -- a single
bad tick (or a transient Supabase blip) NEVER crashes the worker.

Lifecycle: :func:`start_scheduler` is invoked from the FastAPI lifespan on
startup and returns a :class:`Scheduler` whose :meth:`~Scheduler.stop`
cancels every loop and awaits clean exit on shutdown. The whole thing is a
no-op (logs and returns an empty scheduler) when Supabase isn't configured,
exactly like :func:`services.compliance_rules_seed.seed_compliance_rules_safe`
-- so local boots / tests that don't set Supabase env still start cleanly.

All intervals come from :class:`config.Settings` (env-backed) with conservative
defaults; see the ``scheduler_*`` fields there for the documented env vars.
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
from typing import Any, Awaitable, Callable

import structlog

from ..config import Settings, get_settings
from . import observability
from .operator_dispatch_watchdog import StuckDispatch, find_stuck_dispatches


log = structlog.get_logger(__name__)


# ---------------------------------------------------------------------------
# Reconciliation targets -- the one seam that still needs a built data source.
# ---------------------------------------------------------------------------
#
# reconcile_pipeline() needs, per pipeline: a GHL location_id, a campaign_ref
# (attribution string), an ad_entity_id, and a window. The architecture says
# these come from a `client_integrations` table (services/ghl.py docstring),
# but that table is not built yet -- it's referenced only in docstrings. Until
# it lands, this returns [] and the GHL job is a logged no-op. See the
# load_reconciliation_targets() docstring (#354).


class ReconcileTarget:
    """One pipeline to reconcile in the daily GHL pass.

    Plain container (not a pydantic model) so the eventual ``client_integrations``
    read can build these from raw rows with zero ceremony.
    """

    __slots__ = ("pipeline_id", "location_id", "campaign_ref", "ad_entity_id")

    def __init__(
        self,
        *,
        pipeline_id: str,
        location_id: str,
        campaign_ref: str,
        ad_entity_id: str | None = None,
    ) -> None:
        self.pipeline_id = pipeline_id
        self.location_id = location_id
        self.campaign_ref = campaign_ref
        self.ad_entity_id = ad_entity_id


def load_reconciliation_targets() -> list[ReconcileTarget]:
    """Return the pipelines the daily GHL reconciliation should process.

    DEFERRED DATA SOURCE (#354): the per-client (pipeline -> GHL location_id +
    campaign_ref + ad_entity_id) mapping lives in the not-yet-built
    ``client_integrations`` table. Until that schema lands this returns ``[]`` and
    the reconcile job is a safe no-op (it logs "no targets" and sleeps). When the
    table exists, build the list here, e.g.::

        from ..supabase_client import get_supabase_admin
        sb = get_supabase_admin()
        resp = (
            sb.table("client_integrations")
            .select("pipeline_id, ghl_location_id, ghl_campaign_ref, ad_entity_id")
            .eq("active", True)
            .execute()
        )
        rows = resp.data if (resp is not None and isinstance(resp.data, list)) else []
        return [
            ReconcileTarget(
                pipeline_id=r["pipeline_id"],
                location_id=r["ghl_location_id"],
                campaign_ref=r["ghl_campaign_ref"],
                ad_entity_id=r.get("ad_entity_id"),
            )
            for r in rows
            if isinstance(r, dict) and r.get("pipeline_id")
        ]
    """
    return []


# ---------------------------------------------------------------------------
# Job: dispatch watchdog
# ---------------------------------------------------------------------------


def _open_dispatch_rows(sb: Any) -> list[dict[str, Any]]:
    """Read the open (``dispatched``/``running``) operator_dispatches rows."""
    resp = (
        sb.table("operator_dispatches")
        .select(
            "id, dispatch_id, pipeline_id, stage, expected_status, status, "
            "dispatched_at, last_heartbeat_at"
        )
        .in_("status", ["dispatched", "running"])
        .execute()
    )
    return resp.data if (resp is not None and isinstance(resp.data, list)) else []


def _mark_timed_out(sb: Any, *, dispatch_id: str, pipeline_id: str) -> None:
    """Stamp a stuck dispatch ``timed_out`` so it is never re-judged.

    Mirrors the terminal-close payload the ``/work/pipeline/tools/signal`` route
    writes (status + completed_at) so a watchdog-closed row is indistinguishable
    from an operator-closed one to every downstream reader.
    """
    now = datetime.now(timezone.utc).isoformat()
    sb.table("operator_dispatches").update(
        {"status": "timed_out", "completed_at": now, "last_heartbeat_at": now}
    ).eq("pipeline_id", pipeline_id).eq("dispatch_id", dispatch_id).execute()


def _resume_instruction(stuck: StuckDispatch) -> str:
    """Build the re-dispatch instruction for a stuck operator run.

    The operator is stateless per dispatch and re-reads live pipeline state, and
    its per-stage work is skip-done idempotent (see the watchdog module
    docstring), so a generic "resume from where you left off" is safe -- no
    duplicate spend, no double work.
    """
    stage = stuck.stage or "the current stage"
    return (
        f"Resume pipeline {stuck.pipeline_id}: the previous dispatch for "
        f"{stage} stalled (idle {stuck.idle_seconds:.0f}s) and was timed out. "
        "Re-read the live pipeline state and continue; already-completed work is "
        "skipped automatically."
    )


async def run_dispatch_watchdog_once(settings: Settings) -> int:
    """One pass of the stuck-dispatch watchdog. Returns rows re-dispatched.

    Reads the open ``operator_dispatches`` rows, asks the pure
    :func:`find_stuck_dispatches` core which are wedged past the timeout, then for
    each: marks it ``timed_out`` and re-dispatches the operator (idempotent
    resume). Bounded by ``scheduler_watchdog_max_redispatch`` per pass so a
    backlog can't fan out an unbounded burst of docker execs.
    """
    from ..supabase_client import get_supabase_admin  # lazy: never forces a client
    from .operator_bridge import OperatorBridgeError, get_operator_bridge

    sb = get_supabase_admin()
    rows = _open_dispatch_rows(sb)
    stuck = find_stuck_dispatches(
        rows,
        timeout=timedelta(seconds=settings.scheduler_watchdog_timeout_s),
    )
    if not stuck:
        log.info("watchdog_no_stuck_dispatches", open_rows=len(rows))
        return 0

    bridge = get_operator_bridge()
    redispatched = 0
    for item in stuck[: settings.scheduler_watchdog_max_redispatch]:
        # Mark timed_out FIRST so a re-dispatch that itself stalls is judged from
        # its own fresh row, not this one (no thrash on the same dispatch_id).
        try:
            _mark_timed_out(
                sb, dispatch_id=item.dispatch_id, pipeline_id=item.pipeline_id
            )
        except Exception as exc:  # noqa: BLE001 -- one bad row never sinks the pass
            log.warning(
                "watchdog_mark_timed_out_failed",
                dispatch_id=item.dispatch_id,
                pipeline_id=item.pipeline_id,
                error=str(exc),
            )
            continue

        try:
            await bridge.dispatch(_resume_instruction(item), item.pipeline_id)
            redispatched += 1
            log.info(
                "watchdog_redispatched",
                dispatch_id=item.dispatch_id,
                pipeline_id=item.pipeline_id,
                stage=item.stage,
                idle_seconds=round(item.idle_seconds, 1),
            )
        except OperatorBridgeError as exc:
            log.warning(
                "watchdog_redispatch_failed",
                dispatch_id=item.dispatch_id,
                pipeline_id=item.pipeline_id,
                error=str(exc),
            )

    log.info(
        "watchdog_pass_done",
        stuck=len(stuck),
        redispatched=redispatched,
        open_rows=len(rows),
    )
    return redispatched


# ---------------------------------------------------------------------------
# Job: observability watchdogs (alerting)
# ---------------------------------------------------------------------------


def _all_dispatch_rows(sb: Any) -> list[dict[str, Any]]:
    resp = (
        sb.table("operator_dispatches")
        .select("dispatch_id, id, pipeline_id, status, dispatched_at, last_heartbeat_at")
        .execute()
    )
    return resp.data if (resp is not None and isinstance(resp.data, list)) else []


def _all_outbox_rows(sb: Any) -> list[dict[str, Any]]:
    resp = (
        sb.table("integration_outbox")
        .select("idempotency_key, id, pipeline_id, status, created_at")
        .execute()
    )
    return resp.data if (resp is not None and isinstance(resp.data, list)) else []


async def run_observability_once(settings: Settings) -> dict[str, int]:
    """One pass of the observability watchdogs. Returns the stuck counts.

    Classifies stuck operator dispatches + stuck outbox rows via the pure cores
    in :mod:`services.observability` and logs a structured alert line per stuck
    item (greppable by ``pipeline_id``). Slack fan-out is intentionally NOT wired
    here yet -- the observability module's docstring defers it to the
    :mod:`services.notifications` Slack helper; emitting structured logs now means
    log-based alerting works immediately and the Slack call is a one-line add
    later (call it inside the loops below).
    """
    from ..supabase_client import get_supabase_admin

    sb = get_supabase_admin()
    now = datetime.now(timezone.utc)

    stuck_disp = observability.stuck_dispatches(
        _all_dispatch_rows(sb),
        now=now,
        timeout_s=settings.scheduler_observability_dispatch_timeout_s,
    )
    stuck_ob = observability.stuck_outbox(
        _all_outbox_rows(sb),
        now=now,
        timeout_s=settings.scheduler_observability_outbox_timeout_s,
    )

    for item in stuck_disp:
        log.warning(
            "observability_stuck_dispatch",
            ref=item.ref,
            pipeline_id=item.pipeline_id,
            age_s=round(item.age_s, 1),
        )
    for item in stuck_ob:
        log.warning(
            "observability_stuck_outbox",
            ref=item.ref,
            pipeline_id=item.pipeline_id,
            age_s=round(item.age_s, 1),
        )

    log.info(
        "observability_pass_done",
        stuck_dispatches=len(stuck_disp),
        stuck_outbox=len(stuck_ob),
    )
    return {"stuck_dispatches": len(stuck_disp), "stuck_outbox": len(stuck_ob)}


# ---------------------------------------------------------------------------
# Job: GHL daily reconciliation
# ---------------------------------------------------------------------------


async def run_reconciliation_once(settings: Settings) -> int:
    """One daily reconciliation pass over the active reconcile targets.

    For each target (see :func:`load_reconciliation_targets`): build the look-back
    window, count GHL leads, sum Meta spend, compute real CPL, and write a
    ``campaign_perf_image`` row -- all via the existing pure core
    :func:`routes.integrations.reconcile_pipeline`. One GHL client is shared
    across the pass and closed at the end. A per-target failure is logged and
    skipped so one bad client never aborts the whole nightly run.

    Returns the number of targets reconciled. When there are no targets (the
    ``client_integrations`` source isn't built yet) this is a logged no-op.
    """
    targets = load_reconciliation_targets()
    if not targets:
        log.info("reconciliation_no_targets")
        return 0

    # Imported lazily so the scheduler module never forces these heavier imports
    # at import time (and so tests can patch them on the route module).
    from ..routes.integrations import reconcile_pipeline
    from .ghl import GhlClient

    now = datetime.now(timezone.utc)
    window = (now - timedelta(days=settings.scheduler_reconcile_window_days), now)

    reconciled = 0
    client = GhlClient()  # FAKE_GHL-aware; needs no key under the fake flag
    try:
        for target in targets:
            try:
                result = await reconcile_pipeline(
                    pipeline_id=target.pipeline_id,
                    location_id=target.location_id,
                    campaign_ref=target.campaign_ref,
                    window=window,
                    ghl_client=client,
                    ad_entity_id=target.ad_entity_id,
                )
                reconciled += 1
                log.info(
                    "reconciliation_target_done",
                    pipeline_id=target.pipeline_id,
                    leads=result.ghl_leads,
                    meta_spend_usd=result.meta_spend_usd,
                    real_cpl=result.real_cpl,
                    perf_row_written=result.perf_row_written,
                )
            except Exception as exc:  # noqa: BLE001 -- one client never aborts the run
                log.warning(
                    "reconciliation_target_failed",
                    pipeline_id=target.pipeline_id,
                    error=str(exc),
                )
    finally:
        await client.aclose()

    log.info("reconciliation_pass_done", targets=len(targets), reconciled=reconciled)
    return reconciled


# ---------------------------------------------------------------------------
# Job: kie video render reconciliation (E5.2 / #514)
# ---------------------------------------------------------------------------
#
# THE BUG this job backstops: the live broll-search path submits a kie video
# render and BLOCKS on a 10-minute poll. A restart mid-poll abandoned the render
# (kie still produced + billed the clip, nothing recorded it), and even with the
# new callback receiver a dropped/never-delivered callback would still lose it.
# This sweep is the durable safety net: it finds renders persisted as
# ``submitted`` in ``video_render_tasks`` (migration 0033), polls kie for each
# via a single non-blocking probe, and records the result -- exactly what the
# callback would have done. Idempotent (the callback + the sweep both resolve a
# task by its unique id; the loser sees a terminal row and no-ops) and BOUNDED
# per pass (``scheduler_kie_reconcile_max_per_pass``), mirroring the dispatch
# watchdog's redispatch cap so a backlog can't fan out an unbounded burst.


def _open_render_tasks(sb: Any, *, limit: int) -> list[dict[str, Any]]:
    """Read up to ``limit`` still-``submitted`` video render task rows (oldest first)."""
    resp = (
        sb.table("video_render_tasks")
        .select("id, task_id, is_veo, creative_id, brief_id, theme, status, attempts")
        .eq("status", "submitted")
        .order("submitted_at", desc=False)
        .limit(limit)
        .execute()
    )
    return resp.data if (resp is not None and isinstance(resp.data, list)) else []


async def run_kie_reconcile_once(settings: Settings) -> int:
    """One pass of the kie video render reconciliation. Returns rows resolved.

    Reads the open ``video_render_tasks`` (bounded by
    ``scheduler_kie_reconcile_max_per_pass``), polls kie once for each via
    :meth:`services.kie_video.KieVideoClient.poll_status`, and records the
    outcome: a success downloads + stores the clip and marks the row
    ``completed``; a terminal kie failure marks it ``failed``; a still-pending
    render bumps ``attempts`` and is left for the next pass. A per-row failure is
    logged and skipped so one bad render never aborts the sweep. Idempotent: a
    row the callback already resolved is no longer ``submitted`` and is skipped.
    """
    from datetime import datetime, timezone

    from ..routes import video_callback
    from ..supabase_client import get_supabase_admin  # lazy: never forces a client
    from .kie_video import (
        RENDER_FAILED,
        RENDER_SUCCESS,
        KieVideoClient,
    )

    sb = get_supabase_admin()
    rows = _open_render_tasks(sb, limit=settings.scheduler_kie_reconcile_max_per_pass)
    if not rows:
        log.info("kie_reconcile_no_open_renders")
        return 0

    client = KieVideoClient()
    now_iso = datetime.now(timezone.utc).isoformat()
    resolved = 0
    for row in rows:
        task_id = row.get("task_id")
        if not isinstance(task_id, str) or not task_id:
            continue
        try:
            status = await client.poll_status(task_id, bool(row.get("is_veo")))
        except Exception as exc:  # noqa: BLE001 -- one bad render never sinks the pass
            log.warning("kie_reconcile_poll_failed", task_id=task_id, error=str(exc))
            _bump_render_attempt(sb, task_id, now_iso)
            continue

        if status.state == RENDER_SUCCESS:
            try:
                stored = await video_callback._store_render_result(
                    task_id=task_id, theme=row.get("theme"), urls=status.urls
                )
            except Exception as exc:  # noqa: BLE001 -- store failure is non-terminal
                log.warning(
                    "kie_reconcile_store_failed", task_id=task_id, error=str(exc)
                )
                _bump_render_attempt(sb, task_id, now_iso)
                continue
            video_callback._mark_completed(
                task_id,
                result_url=status.urls[0],
                clip_id=str(stored.get("clip_id") or "") or None,
            )
            resolved += 1
            log.info(
                "kie_reconcile_recorded",
                task_id=task_id,
                creative_id=row.get("creative_id"),
                clip_id=stored.get("clip_id"),
            )
        elif status.state == RENDER_FAILED:
            sb.table("video_render_tasks").update(
                {
                    "status": "failed",
                    "error": status.error or "kie reported a render failure",
                    "completed_at": now_iso,
                }
            ).eq("task_id", task_id).execute()
            resolved += 1
            log.info("kie_reconcile_marked_failed", task_id=task_id)
        else:
            _bump_render_attempt(sb, task_id, now_iso)

    log.info("kie_reconcile_pass_done", open_rows=len(rows), resolved=resolved)
    return resolved


def _bump_render_attempt(sb: Any, task_id: str, now_iso: str) -> None:
    """Stamp a still-pending render's last-checked time + bump its attempt count."""
    try:
        existing = (
            sb.table("video_render_tasks")
            .select("attempts")
            .eq("task_id", task_id)
            .maybe_single()
            .execute()
        )
        attempts = 0
        if existing is not None and isinstance(existing.data, dict):
            attempts = int(existing.data.get("attempts") or 0)
        sb.table("video_render_tasks").update(
            {"attempts": attempts + 1, "updated_at": now_iso}
        ).eq("task_id", task_id).execute()
    except Exception as exc:  # noqa: BLE001 -- bookkeeping never aborts the sweep
        log.warning("kie_reconcile_attempt_bump_failed", task_id=task_id, error=str(exc))


# ---------------------------------------------------------------------------
# Job: transactional-outbox relay (E5.1 / #510)
# ---------------------------------------------------------------------------
#
# Drains the ``integration_outbox`` (the durable external-write queue): claims
# due rows, performs the registered side effect, records success or backs off /
# dead-letters on failure. Bounded per pass (``scheduler_outbox_max_per_pass``)
# like every other cron core. The pure pass lives in :mod:`services.outbox_relay`
# (injectable handlers, no I/O of its own); this is the thin scheduler seam that
# supplies the wired handler set.


async def run_outbox_relay_once(settings: Settings) -> int:
    """One pass of the transactional-outbox relay. Returns rows resolved.

    Thin wrapper over :func:`services.outbox_relay.run_outbox_relay_once` that
    supplies the wired ``(integration, op) -> handler`` map. "Resolved" counts
    the rows this pass took to a terminal-ish outcome (done + dead-lettered);
    backed-off + skipped rows are not counted (they recur next pass). Imported
    lazily so the scheduler module never forces the relay's imports at import
    time and tests can patch it on either module.
    """
    from .outbox_relay import default_handlers, run_outbox_relay_once as _relay_pass

    result = await _relay_pass(settings, handlers=default_handlers())
    return result.done + result.dead_lettered


# ---------------------------------------------------------------------------
# Loop supervisor + lifecycle
# ---------------------------------------------------------------------------


async def _interval_loop(
    name: str,
    interval_s: float,
    job: Callable[[], Awaitable[Any]],
    *,
    initial_delay_s: float = 0.0,
) -> None:
    """Run ``job`` every ``interval_s`` seconds until cancelled.

    Each tick is wrapped: ``CancelledError`` propagates (clean shutdown), but
    every other exception is logged and the loop continues -- a job NEVER crashes
    the worker. ``initial_delay_s`` staggers job start-up so they don't all fire
    in the same tick at boot.
    """
    if initial_delay_s:
        try:
            await asyncio.sleep(initial_delay_s)
        except asyncio.CancelledError:
            return
    log.info("scheduler_job_loop_started", job=name, interval_s=interval_s)
    while True:
        try:
            await job()
        except asyncio.CancelledError:
            log.info("scheduler_job_loop_cancelled", job=name)
            raise
        except Exception as exc:  # noqa: BLE001 -- a job tick never kills the loop
            log.error("scheduler_job_failed", job=name, error=str(exc), exc_info=True)
        try:
            await asyncio.sleep(interval_s)
        except asyncio.CancelledError:
            log.info("scheduler_job_loop_cancelled", job=name)
            raise


class Scheduler:
    """Owns the background job tasks and shuts them down cleanly.

    Constructed by :func:`start_scheduler`; the FastAPI lifespan calls
    :meth:`stop` on shutdown to cancel every loop and await its exit.
    """

    def __init__(self, tasks: list[asyncio.Task[Any]]) -> None:
        self._tasks = tasks

    @property
    def task_count(self) -> int:
        return len(self._tasks)

    async def stop(self) -> None:
        """Cancel every job loop and await clean exit (idempotent)."""
        if not self._tasks:
            return
        for task in self._tasks:
            task.cancel()
        # return_exceptions so a task that raised on cancel doesn't mask shutdown.
        await asyncio.gather(*self._tasks, return_exceptions=True)
        log.info("scheduler_stopped", jobs=len(self._tasks))
        self._tasks = []


def start_scheduler(settings: Settings | None = None) -> Scheduler:
    """Start the background job loops and return a :class:`Scheduler` (#354).

    Idempotent + safe: when Supabase isn't configured (local boot / tests) or
    when scheduling is disabled via ``SCHEDULER_ENABLED=false``, this logs and
    returns an empty :class:`Scheduler` (``task_count == 0``) -- the app boots
    normally with no loops. Otherwise it spawns one supervised loop per job:
    the dispatch watchdog, the observability watchdogs, and (no-op until targets
    exist) the daily GHL reconciliation.

    Must be called from inside a running event loop (the FastAPI lifespan).
    """
    settings = settings or get_settings()

    if not settings.scheduler_enabled:
        log.info("scheduler_disabled")
        return Scheduler([])

    # Mirror seed_compliance_rules_safe: no Supabase => nothing to schedule. The
    # admin client raises lazily, so probe the config rather than constructing it.
    if not settings.supabase_url or not settings.supabase_secret_key:
        log.info("scheduler_skipped_no_supabase")
        return Scheduler([])

    loop = asyncio.get_event_loop()
    tasks: list[asyncio.Task[Any]] = [
        loop.create_task(
            _interval_loop(
                "dispatch_watchdog",
                settings.scheduler_watchdog_interval_s,
                lambda: run_dispatch_watchdog_once(settings),
                initial_delay_s=5.0,
            ),
            name="scheduler:dispatch_watchdog",
        ),
        loop.create_task(
            _interval_loop(
                "observability",
                settings.scheduler_observability_interval_s,
                lambda: run_observability_once(settings),
                initial_delay_s=15.0,
            ),
            name="scheduler:observability",
        ),
        loop.create_task(
            _interval_loop(
                "ghl_reconcile",
                settings.scheduler_reconcile_interval_s,
                lambda: run_reconciliation_once(settings),
                initial_delay_s=30.0,
            ),
            name="scheduler:ghl_reconcile",
        ),
        loop.create_task(
            _interval_loop(
                "kie_reconcile",
                settings.scheduler_kie_reconcile_interval_s,
                lambda: run_kie_reconcile_once(settings),
                initial_delay_s=20.0,
            ),
            name="scheduler:kie_reconcile",
        ),
        loop.create_task(
            _interval_loop(
                "outbox_relay",
                settings.scheduler_outbox_interval_s,
                lambda: run_outbox_relay_once(settings),
                initial_delay_s=10.0,
            ),
            name="scheduler:outbox_relay",
        ),
    ]
    log.info("scheduler_started", jobs=len(tasks))
    return Scheduler(tasks)


__all__ = [
    "ReconcileTarget",
    "Scheduler",
    "load_reconciliation_targets",
    "run_dispatch_watchdog_once",
    "run_kie_reconcile_once",
    "run_observability_once",
    "run_outbox_relay_once",
    "run_reconciliation_once",
    "start_scheduler",
]
