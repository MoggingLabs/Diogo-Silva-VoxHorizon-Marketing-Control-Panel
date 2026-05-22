-- 0015_operator_launch_approval.sql
-- Auto-approve the brief + finals when an OPERATOR-DRIVEN pipeline reaches done.
--
-- Background
-- ----------
-- An operator/codex pipeline (`pipelines.config_draft.operator_driven = true`)
-- runs the image-ad pipeline like a hired employee: the Hermes operator authors
-- the brief and renders the finals via `/work/pipeline/tools/{render,store_creative}`.
-- Those tools always write `briefs.status='draft'` and final
-- `creatives.status='draft'` — there is NO dashboard reviewer in the loop to
-- click "approve" on the brief and on each final the way the legacy Ekko flow
-- requires. The pipeline reaches `status='done'` with everything still `draft`.
--
-- `POST /api/launches` then hard-blocks: it requires the brief to be
-- `approved`/`approved_with_changes` (409) and only reads creatives in status
-- `approved`/`live`. So an operator pipeline can never produce a launch package.
--
-- Fix
-- ---
-- The cleanest stamp point is the SAME trigger that flips the pipeline to
-- `done` (0007 → 0014): the moment generation closes, an operator-driven
-- pipeline has its brief + finals approved automatically (the manager already
-- signed off the spend at the Review gate; for the operator flow that gate IS
-- the human approval, and there is no later per-asset reviewer). The legacy
-- Ekko / deterministic flow is untouched — it keeps its dashboard
-- brief-approve + per-creative decide steps, because we only stamp when
-- `config_draft.operator_driven = true`.
--
-- Scope of the auto-approval (operator-driven pipelines only):
--   * the linked brief (`pipelines.image_brief_id`): draft → approved.
--   * the final creatives for that brief (`version like 'v1%'`, type image):
--     draft → approved, stamping `approved_at`. Ideation concepts
--     (`v0.ideation`) are left as drafts — only finals launch.
--
-- A one-time backfill at the bottom approves the brief + finals of pipelines
-- that already reached `done` before this migration (so the live Kris
-- pipeline 117925bd-… can launch immediately).

-- ---------------------------------------------------------------------------
-- Helper: stamp a single operator pipeline's brief + finals approved.
-- ---------------------------------------------------------------------------
-- Idempotent: re-running on an already-approved pipeline is a no-op (the
-- `status = 'draft'` guards). Used by both the done trigger and the backfill.
create or replace function approve_operator_pipeline_outputs(p_pipeline_id uuid)
returns void
language plpgsql
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

  -- Only operator-driven pipelines auto-approve; the legacy flow keeps its
  -- human review steps. Nothing to do without a linked brief.
  if not coalesce(v_operator_driven, false) or v_brief_id is null then
    return;
  end if;

  -- Brief: draft → approved. Stamp decided_at / decided_by for parity with the
  -- dashboard approve route (briefs use decided_*; there is no approved_at
  -- column on briefs). The launch route's 409 gate then passes.
  update briefs
     set status = 'approved',
         decided_at = coalesce(decided_at, now()),
         decided_by = coalesce(decided_by, 'operator')
   where id = v_brief_id
     and status = 'draft';

  -- Finals: draft → approved. Finals are `version like 'v1%'` (the
  -- v0.ideation concepts stay drafts — only finals launch). Stamp approved_at
  -- to mirror the per-creative decision route.
  update creatives
     set status = 'approved',
         approved_at = coalesce(approved_at, now())
   where brief_id = v_brief_id
     and type = 'image'
     and version like 'v1%'
     and status = 'draft';
end;
$$;

-- ---------------------------------------------------------------------------
-- Re-define the done auto-advance trigger fn to call the helper after the flip.
-- ---------------------------------------------------------------------------
-- Body is identical to 0014 up to the point where the pipeline actually moves
-- to `done` (v_updated_count > 0); we add a single call to the helper there so
-- the brief + finals approve in the SAME transaction that flips the stage.
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
    -- Operator-driven pipelines have no later dashboard reviewer, so the moment
    -- generation closes we auto-approve the brief + finals (no-op for the
    -- legacy Ekko/deterministic flow — the helper gates on operator_driven).
    perform approve_operator_pipeline_outputs(new.pipeline_id);

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

-- ---------------------------------------------------------------------------
-- One-time backfill: approve brief + finals of already-`done` operator
-- pipelines so they can launch now (incl. the live Kris pipeline).
-- ---------------------------------------------------------------------------
do $$
declare
  r record;
begin
  for r in
    select id
      from pipelines
     where status = 'done'
       and coalesce((config_draft->>'operator_driven')::boolean, false) = true
  loop
    perform approve_operator_pipeline_outputs(r.id);
  end loop;
end;
$$;
