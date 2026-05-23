-- 0023_supporting_tables_and_extends.sql
-- Remaining new tables (concepts, cost_ledger, operator_dispatches,
-- client_integrations, transactional outbox + inbox) and the extensions to
-- existing tables (creatives finalize/lineage cols, campaign_perf_image links).

-- ---------------------------------------------------------------------------
-- concepts: promoted out of brief jsonb so review-stage scoring + concept->
-- creative lineage are queryable/FK-able.
-- ---------------------------------------------------------------------------
create table concepts (
  id              uuid primary key default gen_random_uuid(),
  brief_id        uuid not null references briefs (id) on delete cascade,
  pipeline_id     uuid references pipelines (id) on delete cascade,
  idx             int not null,
  angle           text,
  offer_text      text,
  headline_hint   text,
  spec            jsonb not null default '{}'::jsonb,
  score           numeric,
  score_rationale text,
  picked          boolean not null default false,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (brief_id, idx)
);
create index concepts_brief_idx on concepts (brief_id);
create index concepts_pipeline_idx on concepts (pipeline_id) where pipeline_id is not null;
create trigger concepts_set_updated_at
  before update on concepts for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- cost_ledger: normalized, queryable cost across Kie/codex generation + Meta
-- spend (the JSONB pipelines.cost_actual stays as the trigger-folded rollup).
-- ---------------------------------------------------------------------------
create table cost_ledger (
  id          uuid primary key default gen_random_uuid(),
  pipeline_id uuid not null references pipelines (id) on delete cascade,
  creative_id uuid references creatives (id) on delete set null,
  kind        cost_kind_enum not null,
  api         text,                                        -- 'kie.ai' | 'openai-codex' | 'meta' | ...
  units       numeric not null default 0,
  amount_usd  numeric not null default 0,
  meta        jsonb,
  created_at  timestamptz not null default now()
);
create index cost_ledger_pipeline_idx on cost_ledger (pipeline_id, created_at desc);

-- ---------------------------------------------------------------------------
-- operator_dispatches: completion/health tracking for the (today blind)
-- fire-and-forget operator dispatch. A row with no terminal status past timeout
-- is "stuck" -> watchdog re-dispatch.
-- ---------------------------------------------------------------------------
create table operator_dispatches (
  id                uuid primary key default gen_random_uuid(),
  pipeline_id       uuid not null references pipelines (id) on delete cascade,
  stage             pipeline_status_enum not null,
  dispatch_id       text not null,
  status            text not null default 'dispatched'
                      check (status in ('dispatched', 'running', 'completed', 'failed', 'timed_out')),
  expected_status   pipeline_status_enum,
  exec_id           text,
  summary           text,
  error             text,
  dispatched_at     timestamptz not null default now(),
  last_heartbeat_at timestamptz,
  completed_at      timestamptz,
  unique (pipeline_id, dispatch_id)
);
create index operator_dispatches_open_idx on operator_dispatches (pipeline_id)
  where status in ('dispatched', 'running');

-- ---------------------------------------------------------------------------
-- client_integrations: client -> external account map (Meta ad account / GHL
-- location / Drive folder). Powers the GHL connector + Meta/Drive recording.
-- ---------------------------------------------------------------------------
create table client_integrations (
  id          uuid primary key default gen_random_uuid(),
  client_id   uuid not null references clients (id) on delete cascade,
  provider    text not null check (provider in ('meta', 'ghl', 'drive')),
  external_id text,                                        -- act_<id> / ghl location / drive folder id
  config      jsonb not null default '{}'::jsonb,
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (client_id, provider)
);
create trigger client_integrations_set_updated_at
  before update on client_integrations for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- Transactional outbox + inbox for exactly-once external side effects.
-- ---------------------------------------------------------------------------
create table integration_outbox (
  id              uuid primary key default gen_random_uuid(),
  pipeline_id     uuid references pipelines (id) on delete cascade,
  integration     text not null,                           -- 'meta' | 'drive' | 'ghl' | 'operator'
  op              text not null,
  idempotency_key text not null unique,
  request         jsonb not null default '{}'::jsonb,
  status          text not null default 'pending'
                    check (status in ('pending', 'inflight', 'done', 'failed', 'dead')),
  attempts        int not null default 0,
  next_attempt_at timestamptz not null default now(),
  result          jsonb,
  last_error      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index integration_outbox_due_idx on integration_outbox (next_attempt_at)
  where status in ('pending', 'inflight');
create trigger integration_outbox_set_updated_at
  before update on integration_outbox for each row execute function set_updated_at();

create table integration_event_inbox (
  provider    text not null,
  event_id    text not null,
  payload     jsonb,
  received_at timestamptz not null default now(),
  primary key (provider, event_id)
);

-- ---------------------------------------------------------------------------
-- Extend creatives: lineage (concept/pipeline) + finalize/Drive metadata +
-- soft-delete. Gate state stays in creative_stage_state (separate axis) -- we
-- do NOT add qa/compliance status to creatives.
-- ---------------------------------------------------------------------------
alter table creatives
  add column if not exists concept_id        uuid references concepts (id),
  add column if not exists pipeline_id       uuid references pipelines (id),
  add column if not exists drive_folder_id   text,
  add column if not exists asset_name        text,            -- naming-convention output
  add column if not exists finalized_at      timestamptz,
  add column if not exists finalize_verified boolean not null default false,
  add column if not exists deleted_at        timestamptz;
create index if not exists creatives_pipeline_active_idx
  on creatives (pipeline_id) where deleted_at is null;
create index if not exists creatives_concept_idx on creatives (concept_id);

-- Extend campaign_perf_image: link perf rows to the pipeline + ad entity so
-- monitor can feed the next brief.
alter table campaign_perf_image
  add column if not exists pipeline_id  uuid references pipelines (id) on delete set null,
  add column if not exists ad_entity_id uuid references ad_entity (id) on delete set null;
create index if not exists campaign_perf_image_pipeline_idx
  on campaign_perf_image (pipeline_id) where pipeline_id is not null;

-- RLS deny-all on new tables.
alter table concepts                enable row level security;
alter table cost_ledger             enable row level security;
alter table operator_dispatches     enable row level security;
alter table client_integrations     enable row level security;
alter table integration_outbox      enable row level security;
alter table integration_event_inbox enable row level security;

-- Dashboard renders concepts (review stage) + dispatch health live.
alter publication supabase_realtime add table concepts;
alter publication supabase_realtime add table operator_dispatches;
