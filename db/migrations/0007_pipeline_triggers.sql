-- ============================================================================
-- 0007_pipeline_triggers.sql
-- ----------------------------------------------------------------------------
-- Database-side automation for the Generation stage.
--
-- Issues:
--   #196 (PF-E-4) — `pipelines.cost_actual` aggregator.
--   #197 (PF-E-5) — auto-advance `generation → done` when every task closes.
--
-- The Generation stage emits a flurry of `pipeline_events` rows as the worker
-- produces final renders:
--
--   * `task_queued` / `task_running` / `task_done` / `task_error` — one chain
--     per substage / ratio (image picks: 1:1 + 9:16; video picks: voiceover,
--     broll, compose, caption, …).
--   * `cost_recorded` — emitted after every paid external call (Kie.ai,
--     ElevenLabs, Hyperframes, Submagic).
--
-- The Next.js UI needs two derived state changes from that stream:
--
--   1. A running `cost_actual.total` on `pipelines` so the operator sees
--      "Cost so far: $X.XX" climb in realtime. The shape mirrors
--      `cost_estimate.items[]` with an `actual_cost` per row.
--   2. The pipeline must auto-flip to `status='done'` the moment the last
--      task chain terminates (every `task_queued` matched by a
--      `task_done` / `task_error`). No operator action — the Generation
--      stage has no Continue button.
--
-- Both behaviours could live in the worker, but doing them in Postgres has
-- two big wins:
--
--   * **Atomicity**: a single SQL UPDATE keeps `cost_actual` consistent
--     under concurrent task chains (image renders interleave with video
--     substages). No client-side read-modify-write race window.
--   * **Resilience**: triggers fire even when a future worker bypasses the
--     orchestrator (e.g. the per-task retry endpoint in PF-E-6 inserts a
--     fresh event chain independently). One enforcement point, many writers.
--
-- Both functions are SECURITY DEFINER-less plain functions — the writer (the
-- worker / API service-role client) already has the privileges to UPDATE
-- `pipelines`, so we don't need to escalate.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. cost_actual aggregator
-- ---------------------------------------------------------------------------
-- Append-and-fold pattern: every `cost_recorded` payload carries
-- `{ api, units, subtotal, extra? }`. We append it as one row inside
-- `cost_actual.items[]` and re-derive `cost_actual.total` from the sum of
-- `actual_cost` across all items. Doing the sum in SQL (rather than reading
-- the old jsonb into a variable, mutating, writing it back) keeps the update
-- atomic under concurrent emitters — Postgres serializes UPDATEs on the
-- same row, and the read inside the SET expression is consistent with
-- the locked snapshot.
--
-- Output shape:
--
--   {
--     "items": [
--       { "api": "kie.ai", "units": 1, "actual_cost": 0.05, "task_event_id": "..." },
--       { "api": "elevenlabs", "units": 1, "actual_cost": 0.05, ... },
--       ...
--     ],
--     "total": 1.74
--   }
--
-- `actual_cost` is the canonical key (matching `cost_estimate.items[].cost`
-- semantics); we also keep the original `subtotal` key in the JSON for
-- parity with the worker payload so debugging is straightforward.

create or replace function pipeline_events_apply_cost_actual()
returns trigger
language plpgsql
as $$
declare
  v_api text;
  v_units numeric;
  v_subtotal numeric;
  v_task_event_id text;
  v_extra jsonb;
  v_item jsonb;
begin
  -- Only react to cost_recorded events. The trigger is on INSERT only so
  -- there's no need to guard on TG_OP.
  if new.kind is distinct from 'cost_recorded' then
    return new;
  end if;

  -- Defensive payload extraction — a malformed event must not abort the
  -- insert (the timeline is append-only and the row already landed).
  v_api := nullif(new.payload->>'api', '');
  if v_api is null then
    return new;
  end if;

  v_units := coalesce((new.payload->>'units')::numeric, 0);
  v_subtotal := coalesce((new.payload->>'subtotal')::numeric, 0);
  v_task_event_id := nullif(new.payload->>'task_event_id', '');
  v_extra := case
    when jsonb_typeof(new.payload->'extra') = 'object' then new.payload->'extra'
    else null
  end;

  v_item := jsonb_build_object(
    'api', v_api,
    'units', v_units,
    'subtotal', v_subtotal,
    'actual_cost', v_subtotal
  );
  if v_task_event_id is not null then
    v_item := v_item || jsonb_build_object('task_event_id', v_task_event_id);
  end if;
  if v_extra is not null then
    v_item := v_item || jsonb_build_object('extra', v_extra);
  end if;

  -- Single UPDATE; reads + mutates the column in one statement so we hold
  -- a row lock for the duration. Concurrent emitters serialise behind
  -- Postgres's per-row write lock and each sees a fresh snapshot.
  --
  -- The COALESCE chain handles the three pre-existing shapes:
  --   * null      → seed `{ items: [item], total: subtotal }`
  --   * existing  → append item, recompute total.
  --
  -- We recompute `total` by summing the (post-append) `items[]` so the
  -- field stays canonical even if a prior row got hand-edited.
  update pipelines p
     set cost_actual = jsonb_build_object(
           'items', coalesce(p.cost_actual->'items', '[]'::jsonb) || jsonb_build_array(v_item),
           'total', (
             select coalesce(sum((elem->>'actual_cost')::numeric), 0)
               from jsonb_array_elements(
                 coalesce(p.cost_actual->'items', '[]'::jsonb) || jsonb_build_array(v_item)
               ) as elem
           )
         ),
         updated_at = now()
   where p.id = new.pipeline_id;

  return new;
end;
$$;

drop trigger if exists pipeline_events_cost_actual_trg on pipeline_events;
create trigger pipeline_events_cost_actual_trg
  after insert on pipeline_events
  for each row
  when (new.kind = 'cost_recorded')
  execute function pipeline_events_apply_cost_actual();

-- ---------------------------------------------------------------------------
-- 2. Auto-advance generation → done
-- ---------------------------------------------------------------------------
-- When the last task chain closes (every task_queued has a matching
-- task_done OR task_error since the latest `stage_advanced→generation`),
-- flip the pipeline forward.
--
-- Closure logic:
--
--   * Cutoff = `created_at` of the most recent
--     `pipeline_events(kind='stage_advanced', stage='generation')` row.
--   * Look at every task event created strictly after that cutoff.
--   * Tasks are "open" when (queued + running) > (done + error).
--     We can't pair-match without an explicit task_id (the worker doesn't
--     emit one consistently for image renders); the count comparison is
--     the same heuristic the worker's idempotency probe uses, so we
--     stay consistent end-to-end.
--   * When the count balances and at least one task has run, we flip
--     `status` and stamp `advanced_at.done`, then emit
--     `pipeline_events(kind='stage_advanced', stage='done')`.
--
-- The UPDATE is gated on `status = 'generation'` so a concurrent advance
-- (or a manual rewind) can't double-promote.

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
  v_pipeline_status text;
  v_updated_count int;
  v_now timestamptz := now();
begin
  -- Only react to task_done / task_error. Other kinds (queued/running/
  -- cost_recorded) can't close the stage.
  if new.kind not in ('task_done', 'task_error') then
    return new;
  end if;
  -- Only react when the event itself is stamped on the generation stage —
  -- a `task_done` from ideation must never auto-flip the pipeline.
  if new.stage is distinct from 'generation' then
    return new;
  end if;

  -- 1. Cheap guard: don't even compute the close-check if the pipeline
  --    isn't currently in generation. Saves a few selects on every
  --    backfill / retry insert after `done`.
  select status into v_pipeline_status
    from pipelines
   where id = new.pipeline_id;
  if v_pipeline_status is null or v_pipeline_status <> 'generation' then
    return new;
  end if;

  -- 2. Cutoff: latest stage_advanced→generation. We capture both id and
  --    timestamp because `now()` is statement-stable within a
  --    transaction — peer rows inserted in the same call share
  --    `created_at` with the stage_advanced row. Filtering by
  --    `id <> v_cutoff_id` reliably excludes the cutoff row even when
  --    its timestamp ties with the events we care about.
  select id, created_at into v_cutoff_id, v_cutoff_ts
    from pipeline_events
   where pipeline_id = new.pipeline_id
     and kind = 'stage_advanced'
     and stage = 'generation'
   order by created_at desc, id desc
   limit 1;

  if v_cutoff_id is null then
    -- No stage_advanced for generation yet — nothing to close.
    return new;
  end if;

  -- 3. Bucket events since the cutoff. The NEW row is already visible
  --    here because the trigger fires AFTER the insert is materialised.
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

  -- 4. Closure heuristic. The worker emits queued + running for every
  --    task, so the queued counter is the upper bound on open work.
  --    When done + error >= queued, every chain has resolved.
  if v_queued = 0 or (v_done + v_error) < v_queued then
    return new;
  end if;

  -- 5. Flip the pipeline forward. The status guard makes this a no-op
  --    on a concurrent transition; v_updated_count tells us whether we
  --    actually moved the needle, in which case we emit the
  --    stage_advanced event.
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
        'task_queued_count', v_queued
      )
    );
  end if;

  return new;
end;
$$;

drop trigger if exists pipeline_events_auto_advance_done_trg on pipeline_events;
create trigger pipeline_events_auto_advance_done_trg
  after insert on pipeline_events
  for each row
  when (new.kind in ('task_done', 'task_error'))
  execute function pipeline_events_auto_advance_done();
