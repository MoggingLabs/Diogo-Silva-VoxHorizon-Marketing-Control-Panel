-- 0019_pipeline_work_units.sql
-- Explicit work-unit ledger for AGENT_WORK stages (generation, finalize_assets).
-- Replaces the event-COUNT closure heuristic (0007/0014) that let an all-failed
-- generation reach 'done'. Closure is now exact and key-addressable:
--   closed  = NO unit in (queued, running)
--   success = >= 1 unit 'done'
-- A unit is seeded BEFORE dispatch (we know picks x ratios up front), so the
-- ledger is the authority for "did the work finish?" rather than counting the
-- denormalized pipeline_events timeline.

create table pipeline_work_units (
  id              uuid primary key default gen_random_uuid(),
  pipeline_id     uuid not null references pipelines (id) on delete cascade,
  -- The macro stage this unit belongs to (e.g. 'generation', 'finalize_assets').
  stage           pipeline_status_enum not null,
  -- What kind of work (e.g. 'render_final', 'render_preview', 'finalize_asset').
  kind            text not null,
  creative_id     uuid references creatives (id) on delete cascade,
  ratio           ratio,
  -- Deterministic key so a retry/resume hits the same unit (idempotent dispatch).
  idempotency_key text not null,
  status          text not null default 'queued'
    check (status in ('queued', 'running', 'done', 'error')),
  attempts        int not null default 0,
  last_error      text,
  result          jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (pipeline_id, idempotency_key)
);

comment on table pipeline_work_units is
  'Exact closure ledger for agent-work stages. Replaces the event-count '
  'heuristic; an all-error batch never closes as success.';

create index pipeline_work_units_pipeline_stage_idx
  on pipeline_work_units (pipeline_id, stage);

create index pipeline_work_units_open_idx
  on pipeline_work_units (pipeline_id, stage)
  where status in ('queued', 'running');

-- ---------------------------------------------------------------------------
-- Closure predicate for an agent-work stage: every unit terminal AND >=1 done.
-- The replacement for the generation->done count heuristic (wired in the
-- trigger redesign migration).
-- ---------------------------------------------------------------------------
create or replace function pipeline_work_closed(
  p_pipeline_id uuid,
  p_stage pipeline_status_enum
) returns boolean
  language sql
  stable
as $$
  select
    exists (
      select 1 from pipeline_work_units u
       where u.pipeline_id = p_pipeline_id and u.stage = p_stage
    )
    and not exists (
      select 1 from pipeline_work_units u
       where u.pipeline_id = p_pipeline_id
         and u.stage = p_stage
         and u.status in ('queued', 'running')
    )
    -- "all failed" must NOT count as a successful close.
    and exists (
      select 1 from pipeline_work_units u
       where u.pipeline_id = p_pipeline_id
         and u.stage = p_stage
         and u.status = 'done'
    );
$$;

comment on function pipeline_work_closed(uuid, pipeline_status_enum) is
  'True when all work units for (pipeline,stage) are terminal AND >=1 done. '
  'An all-error batch returns false (no false advance).';

create trigger pipeline_work_units_set_updated_at
  before update on pipeline_work_units
  for each row execute function set_updated_at();

-- RLS deny-all (service-role bypass). Internal ledger — not published to realtime.
alter table pipeline_work_units enable row level security;
