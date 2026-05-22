-- 0014_fix_auto_advance_operator.sql
-- Fix generation→done auto-advance for operator-driven pipelines.
--
-- The 0007 trigger keyed the "all tasks closed" check off `task_queued`
-- (`v_queued = 0` → never advance). The deterministic Ekko worker emits
-- queued→running→done per task, but the dashboard OPERATOR renders via
-- running→done only (no `task_queued`). So operator pipelines had
-- `v_queued = 0` and the generation stage never auto-advanced — it stuck in
-- `generation` until manually flipped to `done`.
--
-- Fix: use greatest(queued, running) as the task-count upper bound, so both
-- flows close when done+error reaches it (Ekko's queued count OR the
-- operator's running count). Pure heuristic change; trigger wiring unchanged.

create or replace function pipeline_events_auto_advance_done()
returns trigger
language plpgsql
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

  -- Closure heuristic. Ekko emits queued+running+done per task; the operator
  -- emits running+done (no queued). Use the larger of queued/running as the
  -- task-count upper bound so both close once done+error reaches it.
  v_expected := greatest(coalesce(v_queued, 0), coalesce(v_running, 0));
  if v_expected = 0 or (v_done + v_error) < v_expected then
    return new;
  end if;

  update pipelines
     set status = 'done',
         advanced_at = coalesce(advanced_at, '{}'::jsonb)
                       || jsonb_build_object('done', to_jsonb(v_now)),
         updated_at = v_now
   where id = new.pipeline_id
     and status = 'generation';

  get diagnostics v_updated_count = row_count;

  if v_updated_count > 0 then
    insert into pipeline_events (pipeline_id, kind, stage, payload)
    values (
      new.pipeline_id,
      'stage_advanced',
      'done',
      jsonb_build_object(
        'reason', 'auto_advance',
        'task_done_count', v_done,
        'task_error_count', v_error,
        'task_queued_count', v_queued,
        'task_running_count', v_running
      )
    );
  end if;

  return new;
end;
$$;
