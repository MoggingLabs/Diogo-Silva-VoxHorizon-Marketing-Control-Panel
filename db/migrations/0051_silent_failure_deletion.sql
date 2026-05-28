-- 0051_silent_failure_deletion.sql
-- ----------------------------------------------------------------------------
-- Silent-failure architectural redesign, PR-4 (deletion pass).
--
-- After this migration applies:
--   * The four per-domain failure tables that 0050's `work_item` queue replaced
--     are RENAMED to `_legacy_*` (NOT dropped -- one-quarter retention so a
--     production read that still hits them is recoverable by a rename-back).
--   * `pipelines.status` -- the mutable rollup column that drifted from the
--     `pipeline_events` audit log -- is DROPPED. From this migration on, the
--     canonical answer to "what stage is this pipeline in?" is the
--     event-sourced `compute_pipeline_status(id)` reducer (migration 0050),
--     exposed via `v_pipeline_dispatch_state.derived_status` for clients.
--
-- The renames are reversible (one-line `alter table ... rename`) so a
-- production reader caught reading from the legacy table surfaces as a 404
-- and we can roll back the rename. The DROP COLUMN is forward-only -- every
-- route was migrated off the column in this PR (every reader now derives
-- status via the RPC, every writer that set the column stopped writing it).
--
-- ADDITIVE in the strict sense: the work_item queue + reducer infrastructure
-- shipped in 0050; this migration only disposes of the dormant primitives.
-- See `~/.claude/plans/idempotent-munching-phoenix.md` for the four-PR plan.
-- ----------------------------------------------------------------------------

-- ============================================================================
-- 1. Rename the legacy per-domain failure tables.
-- ============================================================================
--
-- One-quarter retention: keep the tables around in case a production read
-- somehow still hits them. Strip them out of the realtime publication first
-- so subscribers stop receiving updates immediately (the consumers that
-- subscribed are gone; this is belt-and-braces).
--
-- ``alter publication ... drop table`` lacks the ``if exists`` guard on the
-- table reference (unlike ``drop table``), so we wrap each drop in a DO
-- block that checks ``pg_publication_tables`` first; that way a
-- publication-membership miss (or a missing table on a clean CI database)
-- is a benign skip instead of a migration abort.

do $$
declare
  rel text;
begin
  foreach rel in array array[
    'operator_dispatches', 'integration_outbox', 'video_render_tasks'
  ] loop
    if exists (
      select 1 from pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname = 'public'
         and tablename = rel
    ) then
      execute format(
        'alter publication supabase_realtime drop table public.%I', rel
      );
    end if;
  end loop;
end$$;

alter table if exists operator_dispatches rename to _legacy_operator_dispatches;
alter table if exists integration_outbox  rename to _legacy_integration_outbox;
alter table if exists video_render_tasks  rename to _legacy_video_render_tasks;


-- ============================================================================
-- 2. Replace the generation-closure trigger function.
-- ============================================================================
--
-- The trigger from migration 0046 (`pipeline_events_auto_advance_done()`) READS
-- `pipelines.status` and WRITES `status = 'creative_qa'` to advance. Both go
-- away with the column drop below, so we replace the function FIRST with a
-- version that:
--   * reads the derived status from `compute_pipeline_status(new.pipeline_id)`
--     (the reducer over `pipeline_events`),
--   * writes `advanced_at.creative_qa` ONLY (no status column write),
--   * emits the `stage_advanced -> creative_qa` event the reducer folds in.
--
-- Behaviour-preserving relative to 0046: the closure heuristic, the all-failed
-- guard, the QA-gate seeding for image + video creatives, and the
-- stage_advanced emission are byte-identical. The only difference is the
-- status read/write seam.

create or replace function pipeline_events_auto_advance_done()
  returns trigger
  language plpgsql
  set search_path = public, pg_temp
as $$
declare
  v_cutoff_id uuid;
  v_cutoff_ts timestamptz;
  v_queued bigint;
  v_running bigint;
  v_done bigint;
  v_error bigint;
  v_expected bigint;
  v_pipeline_status pipeline_status_enum;
  v_already_advanced int;
  v_now timestamptz := now();
begin
  if new.kind not in ('task_done', 'task_error') then
    return new;
  end if;
  if new.stage is distinct from 'generation' then
    return new;
  end if;

  -- Silent-failure PR-4: the canonical status is the reducer's output now.
  v_pipeline_status := compute_pipeline_status(new.pipeline_id);
  if v_pipeline_status is null or v_pipeline_status <> 'generation' then
    return new;
  end if;

  select id, created_at into v_cutoff_id, v_cutoff_ts
    from pipeline_events
   where pipeline_id = new.pipeline_id
     and kind = 'stage_advanced'
     and stage = 'generation'
   order by created_at desc, id desc
   limit 1;
  if v_cutoff_id is null then
    return new;
  end if;

  select
      count(*) filter (where kind = 'task_queued'),
      count(*) filter (where kind = 'task_running'),
      count(*) filter (where kind = 'task_done'),
      count(*) filter (where kind = 'task_error')
    into v_queued, v_running, v_done, v_error
    from pipeline_events
   where pipeline_id = new.pipeline_id
     and stage = 'generation'
     and id <> v_cutoff_id
     and created_at >= v_cutoff_ts;

  -- Closure heuristic (Ekko emits queued+running+done; operator emits running+done).
  v_expected := greatest(coalesce(v_queued, 0), coalesce(v_running, 0));
  -- Not closed yet, OR an all-failed batch (v_done = 0) which must NOT advance.
  if v_expected = 0 or (v_done + v_error) < v_expected or v_done < 1 then
    return new;
  end if;

  -- Idempotent: if creative_qa was already advanced (a previous task_done in
  -- the same batch closed it), the reducer would have returned creative_qa
  -- above. Belt-and-braces: check for an existing creative_qa stage_advanced
  -- event keyed to the same generation cutoff so we never seed twice.
  select count(*) into v_already_advanced
    from pipeline_events
   where pipeline_id = new.pipeline_id
     and kind = 'stage_advanced'
     and stage = 'creative_qa'
     and created_at >= v_cutoff_ts;
  if v_already_advanced > 0 then
    return new;
  end if;

  -- Silent-failure PR-4: no `pipelines.status` write; the stage_advanced
  -- event below is the canonical status source. We still bump `advanced_at`
  -- (the per-stage timestamp the UI surfaces).
  update pipelines
     set advanced_at = coalesce(advanced_at, '{}'::jsonb)
                       || jsonb_build_object('creative_qa', to_jsonb(v_now)),
         updated_at = v_now
   where id = new.pipeline_id;

  -- Seed the per-creative QA gate for each final IMAGE creative (idempotent).
  insert into creative_stage_state (pipeline_id, creative_id, stage, status)
  select p.id, c.id, 'creative_qa', 'pending'
    from pipelines p
    join creatives c
      on c.brief_id = p.image_brief_id
     and c.type = 'image'
     and c.version like 'v1%'
     and c.deleted_at is null
   where p.id = new.pipeline_id
  on conflict (creative_id, stage) do nothing;

  -- Seed the per-creative QA gate for each final VIDEO creative (idempotent).
  insert into creative_stage_state (pipeline_id, creative_id, stage, status)
  select p.id, vc.id, 'creative_qa', 'pending'
    from pipelines p
    join video_creatives vc
      on vc.brief_id = p.video_brief_id
     and vc.status = 'captioned'
     and vc.deleted_at is null
   where p.id = new.pipeline_id
  on conflict (creative_id, stage) do nothing;

  insert into pipeline_events (pipeline_id, kind, stage, payload)
  values (
    new.pipeline_id,
    'stage_advanced',
    'creative_qa',
    jsonb_build_object(
      'reason', 'auto_advance',
      'from', 'generation',
      'task_done_count', v_done,
      'task_error_count', v_error
    )
  );

  return new;
end;
$$;


-- ============================================================================
-- 3. Drop pipelines.status.
-- ============================================================================
--
-- The load-bearing change. PR-3 kept the column as a write-only cache so
-- downstream readers could keep compiling through the cutover. PR-4 migrates
-- every reader to compute_pipeline_status(id) / v_pipeline_dispatch_state and
-- drops the column.
--
-- The generation-closure trigger that previously read + wrote the column was
-- replaced above. The realtime publication on `pipelines` will reflect the
-- dropped column on next refresh; subscribers were already migrated to read
-- derived_status from the view.
--
-- Verification before drop (run manually before this migration is applied):
--   select * from information_schema.view_column_usage
--    where column_name = 'status' and table_name = 'pipelines';
-- expected: zero rows (no view depends on the column).

alter table pipelines drop column status;

-- ============================================================================
-- 4. Smoke.
-- ============================================================================
--
-- Verify the reducer + the canonical view still resolve cleanly with the
-- column gone. Both read pipeline_events (untouched) so this is a sanity
-- check, not a correctness one.
--
-- Smoke: select derived_status from v_pipeline_dispatch_state limit 1;
-- expected: returns a non-null pipeline_status_enum value (configuration
-- when the pipeline has no stage_advanced events, the latest stage_advanced
-- target otherwise, or cancelled when a pipeline_cancelled event is present).
