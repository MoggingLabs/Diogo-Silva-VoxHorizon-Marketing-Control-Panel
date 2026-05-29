-- 0056_video_qa_seed.sql
-- ----------------------------------------------------------------------------
-- Silent-failure foundational redesign, FIX-E: surface a FAILED video creative
-- in the creative_qa gate instead of silently dropping a billed render.
--
-- THE BUG (confirmed by the audit's completeness critic). The generation ->
-- creative_qa auto-advance trigger ``pipeline_events_auto_advance_done()`` (most
-- recently replaced by 0054, which also enqueues the creative_qa dispatch) seeds
-- a creative_qa ``creative_stage_state`` row for a VIDEO creative ONLY where
-- ``vc.status = 'captioned'`` (the final, shippable render). BUT the closure
-- heuristic counts ALL task_queued/task_running/task_done/task_error at
-- ``stage = 'generation'`` and advances when ``(v_done + v_error) >= v_expected``
-- AND ``v_done >= 1``. A video concept whose substage chain SHORT-CIRCUITS on an
-- error (compose / caption fails -> ``_run_generation_video_substages`` returns
-- after emitting ONE ``task_error``; see worker/src/routes/pipeline.py) never
-- reaches ``status = 'captioned'`` -- so it is NEVER seeded into creative_qa.
-- YET its ``task_error`` counts toward closure, and ``v_done >= 1`` is satisfied
-- by the image track (or by a sibling video concept that did caption). RESULT:
-- generation advances to creative_qa with the failed (and BILLED -- the paid
-- substages ran before the failure) video creative INVISIBLE to the QA rollup --
-- a partially-rendered video silently absent from the gate, surfaced nowhere.
-- The manager never sees that a paid render failed.
--
-- DETECTION (widen the seed on a generation ``task_error``). The
-- ``video_creative_status`` enum (0001) is
-- ``draft / script_ready / voiceover_ready / broll_ready / composed / captioned
-- / approved / rejected`` -- there is NO ``failed`` value, and none was added by
-- any later migration. ``record_video_stage`` (atomic_inserts_video.py) only ever
-- bumps status FORWARD to the just-completed substage; a substage failure writes
-- NOTHING to ``video_creatives.status`` -- the row simply stays at its last good
-- status (e.g. ``composed`` when caption fails, ``broll_ready`` when compose
-- fails). So a failed render is INDISTINGUISHABLE from an in-flight one by status
-- alone. The reliable signal is the substage failure event itself:
-- ``_run_generation_video_substages`` emits ``task_error`` at
-- ``stage = 'generation'`` with ``payload->>'kind' = 'video'`` and
-- ``payload->>'creative_id' = <the failed video creative id>`` (the image track's
-- errors carry ``kind = 'image'`` and no ``creative_id``, so the filter cannot
-- catch an image error). FIX-E therefore adds a THIRD seed: any in-scope video
-- creative for this pipeline that has a generation ``task_error`` in the SAME
-- closure window (after the generation cutoff).
--
-- WHY status ``'skipped'``, NOT ``'failed'`` (deadlock avoidance). A ``'failed'``
-- gate row BLOCKS the stage (``pipeline_rollup_cleared()``, 0018/0039, treats
-- anything not in passed/overridden/skipped as blocking) and can only leave via an
-- audited ``'overridden'``. But there is NO creative_qa decision/override route in
-- the app: ``compliance/override/route.ts`` is hardcoded to
-- ``STAGE='compliance_review'`` and the only creative_qa writer is ``qa_run`` (a QA
-- verdict, not a manager skip/override). So a ``'failed'`` creative_qa row would be
-- UNCLEARABLE and the pipeline would DEADLOCK at creative_qa on every video
-- substage failure -- strictly worse than the silent-drop this fixes. A failed
-- render is not a deliverable to QA; the correct behaviour is to NOT block the
-- successful creatives and NOT ship the failed one. ``'skipped'`` is in the cleared
-- set, so the gate still clears, while the seeded row + its ``summary`` keep the
-- failed (BILLED) render VISIBLE in the same per-creative rollup the manager
-- reviews (``creative_stage_state`` is realtime-published). The failed video
-- creative's id is a valid ``creative_stage_state.creative_id`` because EVERY
-- ``video_creatives`` row (any status) is mirrored into the neutral ``creative``
-- base on insert (0034) and the FK was repointed to ``creative`` (0035).
--
-- WHAT IS PRESERVED FROM 0054 (byte-identical). The closure heuristic, the
-- all-failed guard, the reducer-based status check, the idempotent
-- ``already_advanced`` guard, the ``advanced_at`` bump, the IMAGE seed, the
-- CAPTIONED-video seed, the ``stage_advanced -> creative_qa`` event, and the
-- FIX-A creative_qa dispatch enqueue (operator_dispatch vs worker_qa, branching
-- on ``config_draft->>'operator_driven'``) are copied verbatim from the 0054
-- body. The ONLY change is the added failed-video seed below the captioned-video
-- seed. The companion function ``work_item_emit_pipeline_event()`` (0054 part 1)
-- is NOT touched by this migration.
--
-- IDEMPOTENCY / SCOPE. The new seed is ``on conflict (creative_id, stage) do
-- nothing`` like the others, so a captioned creative already seeded above is not
-- double-seeded. The captioned seed runs FIRST, so a creative that failed a
-- substage THEN was retried to captioned in the same window keeps its captioned
-- ``'pending'`` QA row (the deliverable gets QA'd); only a creative that has a
-- generation error and never reached captioned lands as ``'skipped'``. The
-- failed-video seed is scoped to the SAME generation closure window
-- (``created_at >= v_cutoff_ts`` and excluding the cutoff event) the closure
-- heuristic uses, so a stale error from a prior generation pass cannot resurrect
-- a creative into this window's gate.
--
-- Forward-only. ``create or replace function`` is idempotent; the existing
-- trigger keeps calling it. search_path is re-pinned (a create-or-replace drops
-- the pin) per the 0029 convention.
-- ----------------------------------------------------------------------------

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

  -- FIX-E: seed the per-creative QA gate for each FAILED video creative as a
  -- VISIBLE-but-NON-BLOCKING ('skipped') row, so a billed render that errored
  -- mid-substage (and so never reached 'captioned') appears in the QA rollup
  -- instead of being silently absent -- WITHOUT deadlocking the pipeline.
  --
  -- WHY 'skipped', NOT 'failed': a 'failed' row blocks the gate
  -- (pipeline_rollup_cleared, 0018, treats anything not in
  -- passed/overridden/skipped as blocking), and there is NO creative_qa
  -- decision/override route in the app -- compliance/override/route.ts is
  -- hardcoded to STAGE='compliance_review', and the only creative_qa writer is
  -- qa_run (a QA verdict, not a manager skip/override). So a 'failed' creative_qa
  -- row would be UNCLEARABLE -> the pipeline would deadlock at creative_qa on
  -- every video substage failure (worse than the silent-drop this fixes). A
  -- failed render is not a deliverable to QA, so the correct behaviour is to NOT
  -- ship it and NOT block the successful creatives: 'skipped' is in the cleared
  -- set, so the gate still clears, while the row + its summary keep the failed
  -- (billed) render visible in the same per-creative rollup the manager reviews
  -- (creative_stage_state is realtime-published).
  --
  -- The signal is the substage failure event: a video substage failure emits a
  -- generation 'task_error' carrying payload.kind = 'video' and
  -- payload.creative_id = the failed video creative (worker pipeline.py
  -- _run_generation_video_substages). video_creative_status has no 'failed'
  -- value, so status alone cannot distinguish a failed render from an in-flight
  -- one -- the error event is the reliable marker. Scoped to the SAME closure
  -- window the heuristic counts (after the generation cutoff, excluding the
  -- cutoff event), joined to in-scope (not soft-deleted) video creatives for this
  -- pipeline's video lineage. Explicit enum casts on the literals: a
  -- ``select distinct`` over heterogeneous columns does not inherit the target
  -- column types the way a plain ``insert ... select`` does, so the unknown-typed
  -- 'creative_qa' / 'skipped' literals must be cast or Postgres raises a
  -- DatatypeMismatch against creative_stage_enum / stage_state_enum. Idempotent:
  -- the (creative_id, stage) conflict no-ops if the captioned seed above already
  -- claimed this creative (a render that failed then was retried to captioned
  -- keeps the captioned 'pending' QA row, not this skip).
  insert into creative_stage_state (pipeline_id, creative_id, stage, status, summary)
  select distinct p.id, vc.id, 'creative_qa'::creative_stage_enum, 'skipped'::stage_state_enum,
         jsonb_build_object(
           'reason', 'generation_render_failed',
           'detail', 'video render failed mid-substage during generation and never '
                     || 'reached captioned; skipped from the QA gate (not a '
                     || 'deliverable) and not shipped, surfaced here so the failed '
                     || '(billed) render is visible to the manager, not silently dropped'
         )
    from pipelines p
    join video_creatives vc
      on vc.brief_id = p.video_brief_id
     and vc.deleted_at is null
    join pipeline_events ev
      on ev.pipeline_id = p.id
     and ev.kind = 'task_error'
     and ev.stage = 'generation'
     and ev.id <> v_cutoff_id
     and ev.created_at >= v_cutoff_ts
     and ev.payload->>'kind' = 'video'
     and ev.payload->>'creative_id' = vc.id::text
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
