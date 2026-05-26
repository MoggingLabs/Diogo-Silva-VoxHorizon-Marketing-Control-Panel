-- 0050_work_item_queue.sql
-- ----------------------------------------------------------------------------
-- Silent-failure architectural redesign, PR-1 (foundational).
--
-- Introduces ONE unified background-work queue (`work_item`) that subsumes the
-- per-domain failure-tracking tables (`operator_dispatches` from 0023,
-- `integration_outbox` from 0023, `video_render_tasks` from 0033) into a
-- single state machine, observer, and dashboard surface. Adds:
--
--   * `work_item` queue + `work_item_consumers` presence table.
--   * `work_item_status` + `work_item_kind` enums + a CHECK matrix that makes
--     half-states (claimed without token, terminal without error_kind,
--     running without heartbeat) structurally impossible.
--   * `claim_work_item(kind, consumer)` atomic claim RPC
--     (FOR UPDATE SKIP LOCKED), the single hot path consumers hit.
--   * Auto-emit trigger from `work_item` status changes -> append-only
--     `pipeline_events` insert. Routes stop emitting transition events
--     manually; the DB does it for them so the `console.warn` swallow paths
--     across the dashboard's decision routes become impossible.
--   * `compute_pipeline_status(pipeline_id)` reducer that folds
--     `pipeline_events` into the canonical pipeline_status_enum value.
--   * `v_pipeline_dispatch_state` view: ONE row per pipeline carrying derived
--     status, active work_item, the last 10 events, and the operator daemon
--     presence row -> what the dashboard's WorkItemPanel reads.
--   * `pipeline_cancel_propagate_to_work_items()` trigger: on a
--     `pipeline_events(kind='pipeline_cancelled')` insert, every open
--     work_item for the pipeline is cancelled with `error_kind='pipeline_cancelled'`.
--
-- ADDITIVE + forward-only. Nothing existing is altered or dropped. The legacy
-- tables remain live; PR-2 dual-writes; PR-3 cuts over; migration 0051 (PR-4)
-- renames them `_legacy_*`. Backward-compatible: every Next route + worker
-- module keeps working exactly as today after this migration applies.
--
-- See `~/.claude/plans/idempotent-munching-phoenix.md` for the four-PR plan.
-- ----------------------------------------------------------------------------

-- ============================================================================
-- 1. Enums
-- ============================================================================

-- The kind enum is forward-compatible: new shapes register via additive
-- `alter type ... add value`. Order is alphabetical-by-domain (operator,
-- outbox, render, worker) so future additions slot logically.
create type work_item_kind as enum (
  -- Operator dispatches (replaces operator_dispatches from 0023).
  'operator_dispatch',
  -- External side effects (replaces integration_outbox rows from 0023).
  'outbox_meta_record_launch',
  'outbox_drive_finalize_verified',
  'outbox_ghl_send',
  -- Render work (replaces video_render_tasks from 0033 + image-render
  -- fire-and-forgets).
  'kie_video_render',
  'kie_image_render',
  'kie_tts',
  'ffmpeg_compose',
  -- Deterministic worker producers (replaces lib/pipeline/worker-calls.ts
  -- fireWorkerIdeation/Generation/Monitor).
  'worker_ideation',
  'worker_generation',
  'worker_monitor',
  -- B-roll search/cache (replaces ad-hoc background calls).
  'broll_search',
  -- Future shapes register here.
  'other'
);

-- ONE state machine for every kind. The watchdog, the consumer, the dashboard
-- all read the same 7 values.
create type work_item_status as enum (
  'queued',
  'claimed',
  'running',
  'completed',
  'failed',
  'timed_out',
  'cancelled'
);

-- ============================================================================
-- 2. The queue table
-- ============================================================================

create table work_item (
  id                    uuid primary key default gen_random_uuid(),
  kind                  work_item_kind not null,

  -- Pipeline lineage (nullable for non-pipeline-scoped work).
  pipeline_id           uuid references pipelines (id) on delete cascade,
  -- Optional creative scope (rendering, qa).
  creative_id           uuid,
  -- Optional brief scope (worker_ideation/generation).
  brief_id              uuid,

  -- State machine.
  status                work_item_status not null default 'queued',
  attempt               int not null default 0,

  -- Single-writer claim invariant: the consumer that wrote claim_token is the
  -- only one allowed to transition this row. The watchdog rotates the token
  -- on requeue; a stale-token consumer's UPDATE returns 0 rows.
  claim_token           uuid,
  claimed_by            text,
  claimed_at            timestamptz,
  heartbeat_at          timestamptz,
  completed_at          timestamptz,

  -- Error trail. error_kind is a stable code (auth_expired / llm_4xx /
  -- llm_5xx / docker_exec_failed / consumer_shutdown / ...). The watchdog,
  -- the dashboard, and alerting key off it. error_detail is the diagnostic
  -- envelope (raw msg, exec_id, http_status, ...).
  error_kind            text,
  error_detail          jsonb,

  -- Per-shape request envelope. Validated in the consumer (not at the DB) so
  -- new kinds register without a migration.
  payload               jsonb not null default '{}'::jsonb,
  -- Per-shape success outcome.
  result                jsonb,

  -- Dedup. Two enqueues with the same key are the same logical work; the
  -- second silently no-ops at the API layer. Per-kind conventions:
  --   operator_dispatch: 'op-disp:<pipeline_id>:<stage>:<nonce>'
  --   outbox_*:          '<integration>:<op>:<domain_natural_key>'
  --   kie_*_render:      'kie:<task_id>'
  idempotency_key       text not null unique,

  -- Retry chain. A timed-out / failed-retryable row that the watchdog
  -- requeues creates a NEW row whose parent points here. The chain is the
  -- audit trail of "this work was tried N times and these are the diagnostics
  -- for each".
  parent_work_item_id   uuid references work_item (id) on delete set null,

  -- Provenance. The Next route or worker module that enqueued this.
  -- Greppable in failure triage: "what created this lost row" in one query.
  created_by            text not null,

  -- When the row should next be eligible for claim (drives exponential
  -- backoff during retry).
  next_attempt_at       timestamptz not null default now(),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  -- ==========================================================================
  -- DB-LEVEL invariants. Every CHECK below kills a silent-failure path.
  -- ==========================================================================

  -- A queued/terminal row has NO claim. A claimed/running row HAS one.
  -- Without this, a route could leave a row "claimed" without a token -> the
  -- watchdog wouldn't know who to chase.
  constraint work_item_claim_consistent check (
    (
      status in ('queued','completed','failed','timed_out','cancelled')
      and claim_token is null
      and claimed_by is null
      and claimed_at is null
    )
    or (
      status in ('claimed','running')
      and claim_token is not null
      and claimed_by is not null
      and claimed_at is not null
    )
  ),

  -- A running row MUST have heartbeated at least once. The first
  -- claimed -> running transition stamps heartbeat_at; the daemon refreshes.
  constraint work_item_running_heartbeated check (
    status <> 'running' or heartbeat_at is not null
  ),

  -- A terminal row MUST carry completed_at AND release the claim. No row can
  -- be "completed without a completion timestamp" or "running with claim held
  -- but already done".
  constraint work_item_terminal_closed check (
    status not in ('completed','failed','timed_out','cancelled')
    or (
      completed_at is not null
      and claim_token is null
      and claimed_by is null
    )
  ),

  -- A failed/timed_out row MUST name what broke. The dashboard surfaces
  -- error_kind; nullable would let a failure show up blank.
  constraint work_item_failure_explained check (
    status not in ('failed','timed_out')
    or error_kind is not null
  )
);

-- ----------------------------------------------------------------------------
-- Indexes (all partial; the queue's hot tables stay small).
-- ----------------------------------------------------------------------------

-- The hot claim query: oldest-eligible queued rows of a kind. SKIP LOCKED
-- friendly because the planner can use this directly.
create index work_item_claim_idx
  on work_item (kind, next_attempt_at)
  where status = 'queued';

-- Watchdog: claimed/running rows whose heartbeat is stale.
create index work_item_heartbeat_idx
  on work_item (heartbeat_at)
  where status in ('claimed','running');

-- Dashboard / view: a pipeline's active work item(s).
create index work_item_pipeline_active_idx
  on work_item (pipeline_id, status)
  where pipeline_id is not null
    and status in ('queued','claimed','running');

-- Dead-letter: terminal-failure rows by recency, for the audit page tile.
create index work_item_dead_letter_idx
  on work_item (created_at desc)
  where status in ('failed','timed_out');

-- Retry-chain navigation (parent -> children).
create index work_item_parent_idx
  on work_item (parent_work_item_id)
  where parent_work_item_id is not null;

-- ----------------------------------------------------------------------------
-- updated_at maintenance via the shared trigger from 0018.
-- ----------------------------------------------------------------------------

create trigger work_item_set_updated_at
  before update on work_item
  for each row execute function set_updated_at();

-- ----------------------------------------------------------------------------
-- RLS deny-all (the established pattern for worker-owned tables: service-role
-- writes via Next API routes; browser never connects directly).
-- ----------------------------------------------------------------------------

alter table work_item enable row level security;

-- Realtime publication (the dashboard's WorkItemPanel subscribes on
-- pipeline_id filter via hooks/useActiveWorkItem.ts).
alter publication supabase_realtime add table work_item;


-- ============================================================================
-- 3. Consumer presence table
-- ============================================================================
--
-- The operator daemon writes a row on startup, refreshes last_seen_at every N
-- seconds, and on clean shutdown marks itself 'stopped'. The dashboard's
-- DaemonHealthBadge reads this and surfaces "live | starting | stale | down".
-- A daemon that fails its startup self-test (e.g. expired Codex OAuth)
-- writes status='down' with startup_check details before exiting; the
-- container restart-loop becomes the LOUD failure signal that today is
-- invisible.

create table work_item_consumers (
  id              text primary key,           -- e.g. 'operator-daemon-1'
  kind            work_item_kind not null,    -- which queue this consumer drains
  status          text not null check (
                    status in ('starting','live','degraded','stopped','down')
                  ),
  startup_check   jsonb,                       -- {auth: 'ok'|'expired', hermes: 'ok'|'init_failed', ...}
  last_seen_at    timestamptz not null default now(),
  image_tag       text,                        -- daemon image version (surfaced in the badge)
  hostname        text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index work_item_consumers_kind_idx
  on work_item_consumers (kind);

create trigger work_item_consumers_set_updated_at
  before update on work_item_consumers
  for each row execute function set_updated_at();

alter table work_item_consumers enable row level security;
alter publication supabase_realtime add table work_item_consumers;


-- ============================================================================
-- 4. Atomic claim RPC
-- ============================================================================
--
-- The consumer's claim entry point. SKIP LOCKED so N consumers never collide.
-- Returns the row with a freshly-minted claim_token, or NULL when nothing is
-- due. Heartbeat / complete / fail are plain `UPDATE ... WHERE id=$id AND
-- claim_token=$token` PATCHes (the token is the single-writer guard); a
-- consumer whose token was rotated by the watchdog gets 0 rows back and
-- aborts cleanly without writing.

create or replace function claim_work_item(
  p_kind     work_item_kind,
  p_consumer text
)
  returns work_item
  language plpgsql
  set search_path = public, pg_temp
as $$
declare
  v_row work_item;
begin
  update work_item
     set status        = 'claimed',
         claim_token   = gen_random_uuid(),
         claimed_by    = p_consumer,
         claimed_at    = now(),
         attempt       = attempt + 1
   where id = (
     select id from work_item
      where kind = p_kind
        and status = 'queued'
        and next_attempt_at <= now()
      order by next_attempt_at
      limit 1
      for update skip locked
   )
   returning * into v_row;
  return v_row;
end;
$$;

revoke execute on function claim_work_item(work_item_kind, text)
  from anon, authenticated;
grant  execute on function claim_work_item(work_item_kind, text)
  to   service_role;


-- ============================================================================
-- 5. The auto-emit trigger (structural anti-drift fix)
-- ============================================================================
--
-- Today, every dashboard decision/advance route does TWO writes -- update
-- `pipelines.status` AND insert a `pipeline_events` row -- and the second can
-- fail after the first commits. The five swallow paths
-- (advance/route.ts:225/513/579/792/899/952, review/decision/route.ts:178/199,
-- creatives/[id]/decision/route.ts:94, launches/[id]/decision/route.ts:86)
-- all `console.warn` and continue, leaving the audit log out of sync with
-- the rollup column.
--
-- This trigger replaces the second write with one the DB does for us, every
-- time a work_item.status changes. Routes can no longer "forget" to log a
-- transition; it's no longer the route's job.
--
-- pipeline_events was made append-only in migration 0041 (UPDATE/DELETE
-- revoked from service_role). This trigger only INSERTs, so that immutability
-- invariant holds.

create or replace function work_item_emit_pipeline_event()
  returns trigger
  language plpgsql
  set search_path = public, pg_temp
as $$
declare
  v_kind text;
  v_stage pipeline_status_enum;
begin
  if new.pipeline_id is null then
    return new;
  end if;
  if (tg_op = 'UPDATE' and new.status is not distinct from old.status) then
    return new;
  end if;

  -- Map (work_item.kind, work_item.status) -> pipeline_events.kind, reusing
  -- the existing well-known kind strings so the timeline / OperatorNarration /
  -- audit views keep working through the dual-write phase.
  v_kind := case
    when new.kind = 'operator_dispatch' and new.status = 'queued'    then 'operator_dispatched'
    when new.kind = 'operator_dispatch' and new.status = 'claimed'   then 'operator_claimed'
    when new.kind = 'operator_dispatch' and new.status = 'running'   then 'operator_running'
    when new.kind = 'operator_dispatch' and new.status = 'completed' then 'operator_completed'
    when new.kind = 'operator_dispatch' and new.status = 'failed'    then 'operator_failed'
    when new.kind = 'operator_dispatch' and new.status = 'timed_out' then 'operator_timed_out'
    when new.kind = 'operator_dispatch' and new.status = 'cancelled' then 'operator_cancelled'
    when new.kind in (
      'kie_video_render','kie_image_render','kie_tts','ffmpeg_compose',
      'worker_ideation','worker_generation','worker_monitor','broll_search'
    ) and new.status = 'queued'    then 'task_queued'
    when new.kind in (
      'kie_video_render','kie_image_render','kie_tts','ffmpeg_compose',
      'worker_ideation','worker_generation','worker_monitor','broll_search'
    ) and new.status = 'claimed'   then 'task_claimed'
    when new.kind in (
      'kie_video_render','kie_image_render','kie_tts','ffmpeg_compose',
      'worker_ideation','worker_generation','worker_monitor','broll_search'
    ) and new.status = 'running'   then 'task_running'
    when new.kind in (
      'kie_video_render','kie_image_render','kie_tts','ffmpeg_compose',
      'worker_ideation','worker_generation','worker_monitor','broll_search'
    ) and new.status = 'completed' then 'task_done'
    when new.kind in (
      'kie_video_render','kie_image_render','kie_tts','ffmpeg_compose',
      'worker_ideation','worker_generation','worker_monitor','broll_search'
    ) and new.status in ('failed','timed_out') then 'task_error'
    when new.kind in (
      'kie_video_render','kie_image_render','kie_tts','ffmpeg_compose',
      'worker_ideation','worker_generation','worker_monitor','broll_search'
    ) and new.status = 'cancelled' then 'task_cancelled'
    else 'work_item_status_changed'
  end;

  -- Safe-cast: payload may carry a stage hint as a string; null when absent.
  -- A bad cast would block the trigger -- explicitly catch and fold to null.
  begin
    v_stage := (new.payload->>'stage')::pipeline_status_enum;
  exception when invalid_text_representation or others then
    v_stage := null;
  end;

  insert into pipeline_events (pipeline_id, kind, stage, payload)
  values (
    new.pipeline_id,
    v_kind,
    v_stage,
    jsonb_build_object(
      'work_item_id',     new.id,
      'work_item_kind',   new.kind::text,
      'work_item_status', new.status::text,
      'attempt',          new.attempt,
      'error_kind',       new.error_kind,
      'error_detail',     new.error_detail,
      'result',           new.result
    )
  );
  return new;
end;
$$;

revoke execute on function work_item_emit_pipeline_event()
  from anon, authenticated;

create trigger work_item_emit_pipeline_event_aiu
  after insert or update of status on work_item
  for each row execute function work_item_emit_pipeline_event();


-- ============================================================================
-- 6. The reducer: pipeline status derived from pipeline_events
-- ============================================================================
--
-- Folds pipeline_events into the current pipeline_status_enum value. The
-- decision routes (in PR-3) stop doing `pipelines.update({status})` and only
-- emit a `pipeline_events(kind='stage_advanced')` row; the reducer answers
-- "what status are we in?" deterministically from the timeline.
--
-- Algorithm (closed-form, no per-stage branch):
--   1. `pipeline_cancelled` event present -> cancelled (terminal escape).
--   2. else the `stage` of the most recent `stage_advanced` event.
--   3. else (empty timeline) -> 'configuration' (a fresh pipeline).
--
-- PG17 still forbids subqueries in `GENERATED ALWAYS AS`, so we cannot make
-- `pipelines.status` a stored generated column. Instead we expose the
-- reducer as a `stable` function the planner inlines on read, and the
-- canonical dashboard view (below) projects through it.

-- ----------------------------------------------------------------------------
-- Monotonic ordering column for pipeline_events.
-- ----------------------------------------------------------------------------
--
-- ``created_at`` (``timestamptz default now()``) is tx-time: every event
-- inserted in the SAME transaction stamps the SAME timestamp, so the reducer
-- cannot order two same-tx events by it. ``id`` is a v4 UUID, NOT
-- chronologically ordered, so it's not a reliable tiebreaker either.
--
-- ``seq`` is a ``bigserial`` -- a session-local sequence that is monotonically
-- increasing across every INSERT regardless of transaction boundary. The
-- reducer orders by ``seq desc`` and gets a deterministic "most recent" even
-- when many ``stage_advanced`` events ride one transaction (the realistic
-- pattern: a route applies several gate transitions in one handler).
--
-- Additive + backfilled in place: existing rows get seq values via the
-- ``bigserial`` default-on-add semantics (Postgres assigns sequence values
-- chronologically by physical row order, which IS in insertion order for an
-- append-only table that has never been re-clustered).
alter table pipeline_events
  add column if not exists seq bigserial;

create index if not exists pipeline_events_pipeline_id_seq_idx
  on pipeline_events (pipeline_id, seq desc);

create or replace function compute_pipeline_status(p_pipeline_id uuid)
  returns pipeline_status_enum
  language sql stable
  set search_path = public, pg_temp
as $$
  select coalesce(
    (select 'cancelled'::pipeline_status_enum
       from pipeline_events
      where pipeline_id = p_pipeline_id and kind = 'pipeline_cancelled'
      limit 1),
    (select stage
       from pipeline_events
      where pipeline_id = p_pipeline_id
        and kind = 'stage_advanced'
        and stage is not null
      order by seq desc
      limit 1),
    'configuration'::pipeline_status_enum
  );
$$;

revoke execute on function compute_pipeline_status(uuid)
  from anon, authenticated;
grant  execute on function compute_pipeline_status(uuid)
  to   service_role;


-- ============================================================================
-- 7. The canonical dashboard view
-- ============================================================================
--
-- ONE row per pipeline; carries the derived status, the currently-active
-- work_item (queued / claimed / running), the last 10 events, and the
-- operator daemon presence row. This is what `hooks/useActiveWorkItem.ts`
-- reads via /api/pipelines/[id]/work-state (server route, service role).
-- Single round-trip per pipeline detail page render.

create or replace view v_pipeline_dispatch_state as
select
  p.id as pipeline_id,
  compute_pipeline_status(p.id) as derived_status,
  -- The currently-active work item for this pipeline, if any. Pipeline-scoped:
  -- an outbox row for a different pipeline never bleeds in.
  (select to_jsonb(wi.*)
     from work_item wi
    where wi.pipeline_id = p.id
      and wi.status in ('queued','claimed','running')
    order by wi.created_at desc
    limit 1) as active_work_item,
  -- The last 10 events (timeline preview). Orders by the monotonic ``seq``
  -- column added above so events emitted in the same transaction tick still
  -- sort deterministically (created_at alone is tx-time -> not unique).
  (select coalesce(jsonb_agg(to_jsonb(e.*) order by e.seq desc), '[]'::jsonb)
     from (select * from pipeline_events
            where pipeline_id = p.id
            order by seq desc
            limit 10) e) as recent_events,
  -- Daemon health for the operator_dispatch kind. The DaemonHealthBadge
  -- reads this; the kickoff form decides "should I let the user kick off?".
  (select to_jsonb(c.*)
     from work_item_consumers c
    where c.kind = 'operator_dispatch'
    order by c.last_seen_at desc nulls last
    limit 1) as operator_daemon
from pipelines p;

grant select on v_pipeline_dispatch_state to service_role;


-- ============================================================================
-- 8. Cancel-propagation trigger
-- ============================================================================
--
-- The dashboard's cancel route (app/api/pipelines/[id]/cancel/route.ts)
-- inserts `pipeline_events(kind='pipeline_cancelled')` and nothing else. This
-- trigger fans the cancel out to every open work_item the pipeline owns, so
-- there's no chance an in-flight operator dispatch keeps writing after the
-- pipeline is cancelled. Single source of truth for cancel propagation.

create or replace function pipeline_cancel_propagate_to_work_items()
  returns trigger
  language plpgsql
  set search_path = public, pg_temp
as $$
begin
  if new.kind = 'pipeline_cancelled' then
    update work_item
       set status       = 'cancelled',
           completed_at = now(),
           claim_token  = null,
           claimed_by   = null,
           -- ``claimed_at`` MUST be cleared alongside the other claim columns:
           -- ``work_item_claim_consistent`` requires every claim column to be
           -- null when the row is in a queued/terminal status. Leaving
           -- claimed_at set on a cancelled row would have violated the CHECK
           -- (caught by the cancel-propagate test).
           claimed_at   = null,
           error_kind   = 'pipeline_cancelled'
     where pipeline_id = new.pipeline_id
       and status in ('queued','claimed','running');
  end if;
  return new;
end;
$$;

revoke execute on function pipeline_cancel_propagate_to_work_items()
  from anon, authenticated;

create trigger pipeline_cancel_propagate_ai
  after insert on pipeline_events
  for each row execute function pipeline_cancel_propagate_to_work_items();
