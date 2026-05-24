-- 0043_cost_fold_incremental.sql
-- E7.3 (#537) DB-growth controls: kill the O(n^2) cost_actual fold.
--
-- Problem
-- -------
-- The 0007 trigger pipeline_events_apply_cost_actual() runs on EVERY
-- cost_recorded event on pipeline_events (the hottest table). It does a
-- read-modify-REWRITE of pipelines.cost_actual (a jsonb array): on each insert it
-- re-summed pipelines.cost_actual->'items' with jsonb_array_elements() to
-- recompute the total. That is O(items) per event, i.e. O(n^2) over a pipeline's
-- life, plus a full jsonb rewrite of an ever-growing array on the hottest path.
--
-- M4 (migration 0036, services.cost_ledger) made cost_ledger the source of truth
-- for cost: emit_cost writes one typed cost_ledger row per spend, and the budget
-- gauge / monitor reconciliation read from there (sum_costs). So the array re-sum
-- is now pure overhead.
--
-- Fix (lowest-risk: keep the column + the shape, drop the O(n^2) rewrite)
-- -----------------------------------------------------------------------
-- pipelines.cost_actual is still read by the web app:
--   * StageGeneration.tsx -> readCostTotal(cost_actual) reads `.total`;
--   * StageDone.tsx        -> readEstimate(cost_actual)  reads `.items[]`+`.total`.
-- No worker code reads it back (cost_ledger.sum_costs is the worker's source).
--
-- So we KEEP the cost_actual column and its { items: [...], total } shape, and
-- only replace the fold's INTERNALS: append the single new item and ADD its
-- actual_cost to the prior total. That is O(1) per event (no array re-scan, no
-- whole-array rewrite beyond the append jsonb still produces), produces the
-- byte-identical column shape, and the same running total the old fold produced
-- for the same event stream -- so every reader keeps working unchanged and no
-- reader is repointed.
--
-- The cost line itself remains authoritatively recorded in cost_ledger (M4);
-- cost_actual is now a cheap denormalized display rollup of the cost_recorded
-- timeline, not a hot-path re-aggregation.
--
-- Forward-only and idempotent (create or replace + drop/create trigger). The
-- trigger name is unchanged so nothing downstream needs re-wiring.

-- ---------------------------------------------------------------------------
-- Incremental cost_actual fold: append item, total := prev_total + actual_cost.
-- ---------------------------------------------------------------------------
-- search_path is re-pinned here (a create-or-replace drops the 0011 pin). We use
-- the project's standard `public, pg_temp` (0024/0029 convention) rather than the
-- older 0011 `pg_catalog, public` -- both resolve `pipelines` / jsonb builtins
-- correctly; pg_temp last is the hardened convention.
create or replace function pipeline_events_apply_cost_actual()
returns trigger
language plpgsql
set search_path = public, pg_temp
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

  -- Defensive payload extraction -- a malformed event must not abort the
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

  -- Same item shape the 0007 fold produced (api/units/subtotal/actual_cost,
  -- plus optional task_event_id / extra) so cost_actual.items[] is unchanged
  -- for StageDone.tsx's breakdown table.
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

  -- O(1) incremental fold (was O(items) in 0007). Append the single new item
  -- and ADD its actual_cost to the PRIOR total instead of re-summing the whole
  -- items[] array. Postgres still serialises concurrent UPDATEs on the same
  -- pipelines row behind the per-row write lock, and the prior-total read inside
  -- the SET expression is consistent with that locked snapshot, so the running
  -- total stays correct under interleaved emitters -- exactly the atomicity the
  -- original fold relied on, now without the per-insert array re-scan.
  --
  -- The COALESCE chain preserves the 0007 seeding behaviour:
  --   * cost_actual null / missing items -> seed { items: [item], total: subtotal }
  --   * existing                         -> append item, total := old_total + subtotal
  update pipelines p
     set cost_actual = jsonb_build_object(
           'items', coalesce(p.cost_actual->'items', '[]'::jsonb)
                    || jsonb_build_array(v_item),
           'total', coalesce((p.cost_actual->>'total')::numeric, 0) + v_subtotal
         ),
         updated_at = now()
   where p.id = new.pipeline_id;

  return new;
end;
$$;

-- Re-create the trigger (idempotent; same name, same firing condition) so the
-- function swap is picked up cleanly on a re-apply.
drop trigger if exists pipeline_events_cost_actual_trg on pipeline_events;
create trigger pipeline_events_cost_actual_trg
  after insert on pipeline_events
  for each row
  when (new.kind = 'cost_recorded')
  execute function pipeline_events_apply_cost_actual();
