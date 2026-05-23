-- 0024_trigger_redesign.sql
-- Rewire the generation-closure trigger for the 12-stage pipeline.
--
-- Changes vs 0015:
--   1. Generation now auto-advances to `creative_qa` (NOT `done`) and SEEDS a
--      creative_stage_state(creative_qa,'pending') row for each final creative,
--      so the per-creative QA gate has rows to evaluate via pipeline_rollup_cleared().
--   2. Adds a "v_done >= 1" guard: an ALL-FAILED generation no longer closes as
--      success (the documented count-heuristic bug). At least one render must
--      succeed for the stage to advance.
--   3. REMOVES the approve_operator_pipeline_outputs() call from generation
--      close. Finals must pass QA + compliance before approval; the auto-approve
--      is re-homed to the launch_handoff transition (wired in the advance/launch
--      route, P2/P5). The helper itself is retained (re-pinned below).
--   4. Re-pins search_path on both functions (0014/0015 CREATE OR REPLACE dropped
--      the 0011 pin -- a real, flagged live deviation).
--
-- Only generation->creative_qa is auto-advanced by a trigger. The other new
-- stages are manager-gated (advance route) or app-driven AUTO (spec->variant_plan,
-- finalize->launch), per the architecture -- DB triggers stay minimal.

-- Re-pin the auto-approve helper (body unchanged from 0015). It is now invoked
-- only by the launch flow (post-compliance), not by the generation trigger.
create or replace function approve_operator_pipeline_outputs(p_pipeline_id uuid)
  returns void
  language plpgsql
  set search_path = public, pg_temp
as $$
declare
  v_brief_id uuid;
  v_operator_driven boolean;
begin
  select
      image_brief_id,
      coalesce((config_draft->>'operator_driven')::boolean, false)
    into v_brief_id, v_operator_driven
    from pipelines
   where id = p_pipeline_id;

  if not coalesce(v_operator_driven, false) or v_brief_id is null then
    return;
  end if;

  update briefs
     set status = 'approved',
         decided_at = coalesce(decided_at, now()),
         decided_by = coalesce(decided_by, 'operator')
   where id = v_brief_id
     and status = 'draft';

  update creatives
     set status = 'approved',
         approved_at = coalesce(approved_at, now())
   where brief_id = v_brief_id
     and type = 'image'
     and version like 'v1%'
     and status = 'draft';
end;
$$;

-- Redefine the generation-closure trigger function: advance to creative_qa,
-- guard against all-failed, seed the QA gate rows, no auto-approve, pinned path.
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
  v_pipeline_status text;
  v_updated_count int;
  v_now timestamptz := now();
begin
  if new.kind not in ('task_done', 'task_error') then
    return new;
  end if;
  if new.stage is distinct from 'generation' then
    return new;
  end if;

  select status into v_pipeline_status
    from pipelines
   where id = new.pipeline_id;
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

  update pipelines
     set status = 'creative_qa',
         advanced_at = coalesce(advanced_at, '{}'::jsonb)
                       || jsonb_build_object('creative_qa', to_jsonb(v_now)),
         updated_at = v_now
   where id = new.pipeline_id
     and status = 'generation';

  get diagnostics v_updated_count = row_count;

  if v_updated_count > 0 then
    -- Seed the per-creative QA gate for each final creative (idempotent).
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
  end if;

  return new;
end;
$$;
