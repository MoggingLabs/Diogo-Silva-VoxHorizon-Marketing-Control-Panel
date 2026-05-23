-- 0022_variant_plan_ad_entity_launch.sql
-- A/B test matrix (variant_plan), the Meta ad-entity recorder (ad_entity), and
-- the launch_handoff gate columns on the existing launch_packages table.

-- ---------------------------------------------------------------------------
-- variant_plan (per-pipeline) + variant_plan_cell (the matrix cells).
-- ---------------------------------------------------------------------------
create table variant_plan (
  id            uuid primary key default gen_random_uuid(),
  pipeline_id   uuid not null references pipelines (id) on delete cascade,
  test_variable text not null,                              -- one variable per test: creative|copy|audience
  hypothesis    text,
  status        text not null default 'draft' check (status in ('draft', 'approved', 'rejected')),
  approved_by   text,
  approved_at   timestamptz,
  notes         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index variant_plan_pipeline_idx on variant_plan (pipeline_id);
create trigger variant_plan_set_updated_at
  before update on variant_plan for each row execute function set_updated_at();

create table variant_plan_cell (
  id              uuid primary key default gen_random_uuid(),
  variant_plan_id uuid not null references variant_plan (id) on delete cascade,
  cell_index      int not null,
  creative_id     uuid references creatives (id) on delete set null,
  copy_variant_id uuid references copy_variants (id) on delete set null,
  audience        jsonb,
  label           text,                                    -- 'A' | 'B' | 'control'
  created_at      timestamptz not null default now(),
  unique (variant_plan_id, cell_index)
);
create index variant_plan_cell_plan_idx on variant_plan_cell (variant_plan_id);

-- ---------------------------------------------------------------------------
-- ad_entity: the Meta campaign/adset/ad/creative graph the operator creates
-- PAUSED-first via its MCP; the worker records the ids here (recorder model).
-- unique(kind, meta_id) makes re-recording the same id an idempotent upsert.
-- ---------------------------------------------------------------------------
create table ad_entity (
  id                uuid primary key default gen_random_uuid(),
  pipeline_id       uuid not null references pipelines (id) on delete cascade,
  launch_package_id uuid references launch_packages (id) on delete set null,
  client_id         uuid references clients (id),
  kind              ad_entity_kind_enum not null,          -- campaign|adset|ad|creative
  meta_id           text not null,
  parent_meta_id    text,                                  -- adset->campaign, ad->adset
  creative_id       uuid references creatives (id),
  copy_variant_id   uuid references copy_variants (id),
  state             ad_entity_state_enum not null default 'paused',  -- PAUSED-first
  meta_payload      jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (kind, meta_id)
);
create index ad_entity_pipeline_idx on ad_entity (pipeline_id);
create index ad_entity_creative_idx on ad_entity (creative_id);
create trigger ad_entity_set_updated_at
  before update on ad_entity for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- launch_packages: add the launch_handoff gate columns. NOTE: we deliberately
-- DO NOT convert launch_packages.status (text) to launch_package_status_enum
-- here -- the live row + the existing launch flow (lib/launches.ts) use values
-- ('rejected', 'posted', 'approved_with_changes') outside the new enum, so a
-- forced cast would break them. The enum is reserved for new code; a later
-- migration can reconcile the column once the launch flow is rebuilt (P3/P5).
-- ---------------------------------------------------------------------------
alter table launch_packages
  add column if not exists pipeline_id      uuid references pipelines (id) on delete set null,
  add column if not exists preconditions    jsonb not null default '{}'::jsonb,  -- {spec_pass,compliance_clear,copy_ge_3}
  add column if not exists approved_by       text,
  add column if not exists approved_at       timestamptz,
  add column if not exists meta_campaign_id  text,
  add column if not exists meta_entities     jsonb,
  add column if not exists launched_at       timestamptz;
create index if not exists launch_packages_pipeline_idx on launch_packages (pipeline_id) where pipeline_id is not null;

-- RLS deny-all on new tables.
alter table variant_plan      enable row level security;
alter table variant_plan_cell enable row level security;
alter table ad_entity         enable row level security;

-- Dashboard renders the A/B plan + launch entity progress live.
alter publication supabase_realtime add table variant_plan;
alter publication supabase_realtime add table ad_entity;
