-- 0039_rollup_excludes_killed.sql
-- ----------------------------------------------------------------------------
-- M2 / E2.3: make pipeline_rollup_cleared() the SINGLE authority for the
-- per-creative gate predicate, and fix the killed-creative DRIFT.
--
-- The "is this per-creative stage cleared?" predicate existed four times and had
-- drifted: this SQL function (0018, advisory only), the advance route's TS
-- computeRollup, lib/review/grid.ts's rollupCleared, and the worker's Python
-- _stage_cleared. THREE of them counted EVERY creative_stage_state row, but the
-- grid dropped killed creatives from the scope. A killed creative must NOT hold a
-- gate, so the grid behaviour is the intended one. We now encode that here and
-- the TS/Python derivations mirror this one function (a parity contract test
-- fails CI if the cleared-state set or the killed-exclusion drifts).
--
-- Scope rule (mirrors lib/pipeline/rollup.ts isCreativeInScope):
--   * a soft-deleted creative (creative.deleted_at is not null) is out of scope;
--   * a KILLED image creative (creatives.status = 'killed') is out of scope.
--     Only image creatives can be killed -- video_creative_status has no 'killed'
--     value -- so a video creative is in scope unless soft-deleted.
--
-- Cleared rule (unchanged): an in-scope (creative, stage) row is cleared when its
-- status is passed | overridden | skipped; the stage is cleared for the pipeline
-- when >=1 in-scope row exists AND every in-scope row is cleared.
--
-- The function keys off creative_stage_state.creative_id -> creative(id) (the
-- neutral base repointed in 0035); the killed status lives on the image
-- extension table (creatives), so we LEFT JOIN it by id.
--
-- STABLE + read-only; search_path pinned (matches 0029 / the rebuild convention).
-- Forward-only, idempotent (create or replace).
-- ----------------------------------------------------------------------------

create or replace function pipeline_rollup_cleared(
  p_pipeline_id uuid,
  p_stage creative_stage_enum
) returns boolean
  language sql
  stable
  set search_path = public, pg_temp
as $$
  with in_scope as (
    select s.status
      from creative_stage_state s
      join creative cr on cr.id = s.creative_id
      left join creatives ci on ci.id = s.creative_id
     where s.pipeline_id = p_pipeline_id
       and s.stage = p_stage
       -- Drop killed / soft-deleted creatives from the rollup scope so a killed
       -- creative can never hold the gate (parity with grid.ts + the advance route).
       and cr.deleted_at is null
       and coalesce(ci.status::text, '') <> 'killed'
  )
  select
    exists (select 1 from in_scope)
    and not exists (
      select 1 from in_scope
       where status not in ('passed', 'overridden', 'skipped')
    );
$$;

comment on function pipeline_rollup_cleared(uuid, creative_stage_enum) is
  'SINGLE authority for the per-creative stage gate (M2/E2.3). True when every '
  'IN-SCOPE seeded creative for (pipeline,stage) is passed/overridden/skipped '
  '(and >=1 exists). Killed (creatives.status=killed) and soft-deleted creatives '
  'are dropped from the scope so they never hold the gate. The TS advance route, '
  'the UI grid, and the worker mirror this predicate (parity-tested).';
