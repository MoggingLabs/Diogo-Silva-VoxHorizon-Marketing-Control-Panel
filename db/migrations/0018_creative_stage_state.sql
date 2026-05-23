-- 0018_creative_stage_state.sql
-- The per-creative gate machine: one row per (creative, stage) for the four
-- per-creative stages (creative_qa, compliance_review, copy, spec_validation).
-- This is the spine of the rebuild's orchestration layer.
--
-- Design:
--   * State axis is ORTHOGONAL to creatives.status (the lifecycle column the
--     launch route + 0015 read). QA/compliance/copy/spec verdicts live here so
--     a pipeline can hold creatives at mixed states.
--   * The detailed, append-only evidence lives in side tables added later
--     (qa_result, compliance_finding, spec_check, copy_variants). This table
--     holds only the rolled-up gate verdict per (creative, stage) + the
--     audited override.
--   * A 'failed' compliance unit can only leave via an audited 'overridden'
--     (override_note REQUIRED, enforced by CHECK) or back to 'in_progress'.
--   * The pipeline-level gate predicate is pipeline_rollup_cleared() below.

create table creative_stage_state (
  id            uuid primary key default gen_random_uuid(),
  pipeline_id   uuid not null references pipelines (id) on delete cascade,
  creative_id   uuid not null references creatives (id) on delete cascade,
  stage         creative_stage_enum not null,
  status        stage_state_enum not null default 'pending',
  -- Rolled-up pointer to the latest verdict / worst finding; full evidence in
  -- the per-stage side tables. Free-shape, so jsonb.
  summary       jsonb not null default '{}'::jsonb,
  decided_by    text,
  -- REQUIRED when status = 'overridden' (a hard-gate release with no written
  -- justification is a compliance hole — enforced at the DB layer).
  override_note text,
  decided_at    timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (creative_id, stage),
  constraint creative_stage_state_override_requires_note
    check (
      status <> 'overridden'
      or (override_note is not null and length(btrim(override_note)) > 0)
    )
);

comment on table creative_stage_state is
  'Per-(creative,stage) gate verdict for the per-creative pipeline stages. '
  'Orthogonal to creatives.status. Drives pipeline_rollup_cleared().';

create index creative_stage_state_pipeline_stage_idx
  on creative_stage_state (pipeline_id, stage);

-- Partial index for the hot "what is still blocking this stage?" query.
create index creative_stage_state_open_idx
  on creative_stage_state (pipeline_id, stage)
  where status in ('pending', 'in_progress', 'failed');

-- ---------------------------------------------------------------------------
-- Rollup gate predicate. A per-creative stage is "cleared" for the pipeline
-- when at least one creative_stage_state row exists for (pipeline, stage) AND
-- every such row is in a terminal-good state (passed | overridden | skipped).
-- The set of rows defines the scope (the worker/operator seeds one row per
-- creative subject to the stage). Used by the advance route AND the UI gate so
-- they agree by construction. STABLE + read-only.
-- ---------------------------------------------------------------------------
create or replace function pipeline_rollup_cleared(
  p_pipeline_id uuid,
  p_stage creative_stage_enum
) returns boolean
  language sql
  stable
as $$
  select
    exists (
      select 1 from creative_stage_state s
       where s.pipeline_id = p_pipeline_id and s.stage = p_stage
    )
    and not exists (
      select 1 from creative_stage_state s
       where s.pipeline_id = p_pipeline_id
         and s.stage = p_stage
         and s.status not in ('passed', 'overridden', 'skipped')
    );
$$;

comment on function pipeline_rollup_cleared(uuid, creative_stage_enum) is
  'True when every seeded creative for (pipeline,stage) is passed/overridden/'
  'skipped (and >=1 exists). The per-creative stage gate predicate.';

-- ---------------------------------------------------------------------------
-- updated_at maintenance. Reusable trigger fn (create-or-replace is idempotent
-- and safe if a same-named helper already exists from another migration).
-- ---------------------------------------------------------------------------
create or replace function set_updated_at()
  returns trigger
  language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger creative_stage_state_set_updated_at
  before update on creative_stage_state
  for each row execute function set_updated_at();

-- RLS: deny-all (service-role bypasses), matching the 0011 lockdown convention.
alter table creative_stage_state enable row level security;

-- Dashboard renders per-creative gate state live -> publish to realtime.
alter publication supabase_realtime add table creative_stage_state;
