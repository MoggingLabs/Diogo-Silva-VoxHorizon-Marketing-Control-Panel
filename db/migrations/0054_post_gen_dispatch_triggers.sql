-- 0054_post_gen_dispatch_triggers.sql
-- ----------------------------------------------------------------------------
-- Silent-failure foundational redesign, FIX-A (post-generation dispatch), part B.
--
-- 0053 added the ``worker_qa`` / ``worker_compliance`` / ``worker_spec`` enum
-- values (in a separate transaction -- the enum-add-then-use hazard). This file
-- USES them, so it MUST be a separate migration file (== a separate psql tx in
-- the Migration apply CI job) from 0053.
--
-- Two create-or-replace function bodies:
--
--   1. work_item_emit_pipeline_event() -- adds the three new kinds to the SAME
--      ``task_*`` mapping lists the other worker_* kinds use, so a per-creative
--      gate work_item emits ``task_queued`` / ``task_running`` / ``task_done`` /
--      ``task_error`` (NOT ``stage_advanced``). The reducer
--      ``compute_pipeline_status`` only folds ``stage_advanced``, so the
--      per-creative gate work can never move the macro pipeline status -- the
--      gate clearance + the manager/route advance own that.
--
--   2. pipeline_events_auto_advance_done() -- after the existing
--      ``stage_advanced -> creative_qa`` insert, enqueues ONE creative_qa
--      dispatch work_item, branching on the pipeline's
--      ``config_draft->>'operator_driven'`` flag:
--        * operator_driven -> ``operator_dispatch`` (the daemon runs the QA chat);
--        * else            -> ``worker_qa`` (the worker-stage consumer fans the
--                             qa_run verdict-writer over the in-scope creatives).
--      This is the missing dispatch PRODUCER for the generation -> creative_qa
--      entry; the downstream per-stage entries (compliance_review / copy /
--      spec_validation / finalize_assets) are dispatched by the Next routes
--      (advance + variant-plan/decision) since those transitions are route-driven.
--
-- Behaviour-preserving for everything except the added work_item INSERT: the
-- closure heuristic, the all-failed guard, the QA-gate seeding for image + video
-- creatives, and the stage_advanced emission are byte-identical to 0051.
--
-- Forward-only. ``create or replace function`` is idempotent.
-- ----------------------------------------------------------------------------

-- ============================================================================
-- 1. work_item_emit_pipeline_event(): map the three new kinds to task_* events.
-- ============================================================================
--
-- Identical to migration 0050's body EXCEPT ``worker_qa`` / ``worker_compliance``
-- / ``worker_spec`` are added to each ``new.kind in (...)`` task_* list. They
-- carry a ``payload.stage`` hint ('creative_qa' / 'compliance_review' /
-- 'spec_validation') for the dashboard, but because the emitted kind is
-- ``task_*`` the reducer ignores the stage (it only folds ``stage_advanced``).

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
  -- audit views keep working. FIX-A adds worker_qa/worker_compliance/worker_spec
  -- to the SAME task_* lists as the other worker_* kinds.
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
      'worker_ideation','worker_generation','worker_monitor','broll_search',
      'worker_qa','worker_compliance','worker_spec'
    ) and new.status = 'queued'    then 'task_queued'
    when new.kind in (
      'kie_video_render','kie_image_render','kie_tts','ffmpeg_compose',
      'worker_ideation','worker_generation','worker_monitor','broll_search',
      'worker_qa','worker_compliance','worker_spec'
    ) and new.status = 'claimed'   then 'task_claimed'
    when new.kind in (
      'kie_video_render','kie_image_render','kie_tts','ffmpeg_compose',
      'worker_ideation','worker_generation','worker_monitor','broll_search',
      'worker_qa','worker_compliance','worker_spec'
    ) and new.status = 'running'   then 'task_running'
    when new.kind in (
      'kie_video_render','kie_image_render','kie_tts','ffmpeg_compose',
      'worker_ideation','worker_generation','worker_monitor','broll_search',
      'worker_qa','worker_compliance','worker_spec'
    ) and new.status = 'completed' then 'task_done'
    when new.kind in (
      'kie_video_render','kie_image_render','kie_tts','ffmpeg_compose',
      'worker_ideation','worker_generation','worker_monitor','broll_search',
      'worker_qa','worker_compliance','worker_spec'
    ) and new.status in ('failed','timed_out') then 'task_error'
    when new.kind in (
      'kie_video_render','kie_image_render','kie_tts','ffmpeg_compose',
      'worker_ideation','worker_generation','worker_monitor','broll_search',
      'worker_qa','worker_compliance','worker_spec'
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


-- ============================================================================
-- 2. pipeline_events_auto_advance_done(): dispatch creative_qa on entry.
-- ============================================================================
--
-- Identical to migration 0051's body up to and including the
-- ``stage_advanced -> creative_qa`` insert; FIX-A then enqueues ONE dispatch
-- work_item for the creative_qa stage. The branch on
-- ``config_draft->>'operator_driven'`` keeps the two execution models from
-- both firing: an operator-driven pipeline gets an ``operator_dispatch`` (the
-- daemon runs the QA chat), a deterministic one gets a ``worker_qa`` (the
-- worker-stage consumer fans qa_run over the in-scope creatives). The INSERT
-- is ``on conflict (idempotency_key) do nothing`` so a watchdog-driven trigger
-- re-fire never double-dispatches. The INSERT fires
-- work_item_emit_pipeline_event -> one operator_dispatched / task_queued event.

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
  v_operator_driven boolean;
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

  -- FIX-A: enqueue the creative_qa dispatch PRODUCER. Without this the stage had
  -- no producer and the pipeline deadlocked here. Branch on operator_driven so
  -- the operator daemon and the deterministic worker-stage consumer never both
  -- fire for the same stage (which would double-charge / double-write).
  select (config_draft->>'operator_driven')::boolean
    into v_operator_driven
    from pipelines
   where id = new.pipeline_id;

  if v_operator_driven is true then
    -- operator_dispatch: the daemon claims this and runs ONE Hermes chat using
    -- payload.instruction. The instruction MUST stay in lockstep with the
    -- ``creative_qa`` case of operatorInstruction() in lib/operator/dispatch.ts
    -- (cross-reference: dispatch.ts:57). The {pipelineId} is interpolated here.
    insert into work_item (kind, pipeline_id, payload, idempotency_key, created_by, status)
    values (
      'operator_dispatch',
      new.pipeline_id,
      jsonb_build_object(
        'stage', 'creative_qa',
        'instruction',
        'Run the QA pass on each final for pipeline ' || new.pipeline_id::text
          || ': pass/fail with defects, flag re-renders, then stop for the manager''s QA sign-off.'
      ),
      'op-disp:' || new.pipeline_id::text || ':creative_qa:auto',
      'trigger:auto_advance',
      'queued'
    )
    on conflict (idempotency_key) do nothing;
  else
    -- worker_qa: the worker-stage consumer claims this and fans the qa_run
    -- verdict-writer over the in-scope creatives in-process.
    insert into work_item (kind, pipeline_id, payload, idempotency_key, created_by, status)
    values (
      'worker_qa',
      new.pipeline_id,
      jsonb_build_object('stage', 'creative_qa'),
      'wi:' || new.pipeline_id::text || ':creative_qa',
      'trigger:auto_advance',
      'queued'
    )
    on conflict (idempotency_key) do nothing;
  end if;

  return new;
end;
$$;
