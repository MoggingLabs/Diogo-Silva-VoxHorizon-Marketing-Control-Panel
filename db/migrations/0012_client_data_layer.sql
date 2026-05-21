-- 0012_client_data_layer.sql
-- Client knowledge layer: the per-client brand / company / campaign data the
-- dashboard operator authors ads from. Today this lives only as JSON files at
-- /docker/hermes-shared/client-profiles/*.json, bind-mounted into the marketing
-- agents (ekko/monarch/forge/archer) but NOT into the operator container — so the
-- operator can't see it. We make the DB the canonical home (seeded from those
-- files, later synced back to them so the file-based agents keep working), and
-- expose it to the operator via the worker.
--
-- Design: normalized-heavy hybrid. Every consistent field becomes a typed column;
-- multi-row arrays become child tables; jsonb is reserved for genuinely
-- variable-shape data (brand_fonts, warranty_details, funnel). raw_profile keeps
-- the full source object so nothing is ever lost. Identity + integration columns
-- already live on `clients` (slug/name/service_type/brand_colors/ghl_location_id/
-- drive_root_folder_id/cpl_target/status) and are NOT duplicated here.
--
-- Conventions (match 0001-0011): snake_case; uuid PKs; FKs to clients(id) with
-- ON DELETE CASCADE; explicit updated_at (no trigger); RLS ENABLED with NO
-- policies = deny-all for anon/authenticated, service_role (worker + Next server)
-- bypasses. See db/migrations/0011_enable_rls_lockdown.sql.

-- 1) Extend service_type beyond roofing|remodeling to cover the real verticals
--    seen in the client files (general contracting, construction, pools).
--    ADD VALUE is transaction-safe in PG12+ as long as the new values are not
--    USED in this same migration (they aren't).
alter type service_type add value if not exists 'general_contracting';
alter type service_type add value if not exists 'construction';
alter type service_type add value if not exists 'pools';

-- 2) client_profiles — 1:1 with clients. Typed columns for the consistent
--    narrative + facts the operator reasons with.
create table client_profiles (
  client_id                 uuid primary key references clients(id) on delete cascade,

  -- brand / voice (brand_colors lives on clients.brand_colors)
  tone                      text,
  tagline                   text,
  voice_note                text,
  brand_fonts               jsonb,        -- {headings, body}
  logo_drive_id             text,
  logo_alt_drive_id         text,

  -- company facts
  legal_name                text,
  business_type             text,
  ein                       text,
  license_number            text,
  years_in_business         integer,
  owner_experience_years    integer,
  family_owned              boolean,
  background                text,
  google_reviews            text,         -- mixed "89"/"700+" -> text
  google_rating             numeric,      -- null when unknown
  bbb_rating                text,
  average_project_value     text,
  minimum_project_size      text,
  residential_projects      integer,
  commercial_projects       integer,
  total_work_orders         integer,
  projects_completed        text,         -- mixed "100+"/11 -> text
  warranty                  text,
  warranty_details          jsonb,        -- {labor, structural, major_systems, manufacturer}
  financing                 text,         -- mixed bool/string -> text
  business_hours            text,
  appointment_availability  text,
  licensed_insured          boolean,

  -- contact
  contact_primary           text,
  contact_secondary         text,
  contact_role              text,
  contact_phone             text,
  contact_email             text,
  company_email             text,

  -- ownership
  owner_name                text,
  annual_revenue            text,
  company_size              text,

  -- location / targeting
  address                   text,
  business_address          text,
  city                      text,
  state                     text,
  primary_city              text,
  primary_zip               text,
  targeting                 text,
  targeting_detail          text,
  timezone                  text,

  -- lead handling
  crm                       text,
  integration               text,
  website                   text,
  booking_flow              text,
  closebot_role             text,
  sales_rep                 text,

  -- campaign (current campaign snapshot; offers/constraints are child tables)
  campaign_name             text,
  campaign_status           text,
  launch_date               date,
  relaunch_date             date,
  targeting_type            text,
  daily_budget              numeric,
  monthly_budget            numeric,
  funnel                    jsonb,        -- {type, pages[], flow, build_url, live_url}

  -- google drive folders (root_folder_id lives on clients.drive_root_folder_id)
  drive_docs_folder_id          text,
  drive_assets_folder_id        text,
  drive_creatives_folder_id     text,
  drive_performance_folder_id   text,
  drive_resources_folder_id     text,
  drive_meeting_notes_folder_id text,
  client_profile_doc_id         text,
  stat_sheet_url                text,

  -- meta
  needs_input               jsonb not null default '[]'::jsonb,  -- unfilled field paths
  raw_profile               jsonb not null default '{}'::jsonb,  -- full source JSON
  updated_at                timestamptz not null default now()
);

-- 3) child tables — arrays become rows, sort_order preserves source order.
create table client_services (
  id           uuid primary key default gen_random_uuid(),
  client_id    uuid not null references clients(id) on delete cascade,
  service_name text not null,
  sort_order   integer not null default 0,
  created_at   timestamptz not null default now()
);
create index client_services_client_id_idx on client_services (client_id);

create type client_value_prop_kind as enum ('usp', 'differentiator');
create table client_value_props (
  id          uuid primary key default gen_random_uuid(),
  client_id   uuid not null references clients(id) on delete cascade,
  kind        client_value_prop_kind not null,
  prop_text   text not null,
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now()
);
create index client_value_props_client_id_idx on client_value_props (client_id);

create table client_offers (
  id          uuid primary key default gen_random_uuid(),
  client_id   uuid not null references clients(id) on delete cascade,
  offer_text  text not null,
  active      boolean not null default true,
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now()
);
create index client_offers_client_id_idx on client_offers (client_id);

-- The do-not-say rules. Critical for compliant, on-brand ad copy.
create table client_offer_constraints (
  id              uuid primary key default gen_random_uuid(),
  client_id       uuid not null references clients(id) on delete cascade,
  constraint_text text not null,
  sort_order      integer not null default 0,
  created_at      timestamptz not null default now()
);
create index client_offer_constraints_client_id_idx
  on client_offer_constraints (client_id);

create type client_asset_kind as enum (
  'logo', 'logo_alt', 'facebook_banner', 'review', 'team_photo',
  'project_photo', 'external', 'existing_creative'
);
create type client_asset_source as enum (
  'drive', 'local', 'url', 'filename', 'descriptor'
);
create table client_assets (
  id          uuid primary key default gen_random_uuid(),
  client_id   uuid not null references clients(id) on delete cascade,
  kind        client_asset_kind not null,
  source      client_asset_source not null,
  ref         text not null,            -- drive id / url / filename / descriptor
  formats     text,                     -- e.g. "1x1, 9x16"
  label       text,                     -- creative name / human descriptor
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now()
);
create index client_assets_client_id_idx on client_assets (client_id);

create table client_past_projects (
  id          uuid primary key default gen_random_uuid(),
  client_id   uuid not null references clients(id) on delete cascade,
  url         text not null,
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now()
);
create index client_past_projects_client_id_idx on client_past_projects (client_id);

-- 4) RLS: deny-all (service_role only), per 0011.
alter table client_profiles          enable row level security;
alter table client_services          enable row level security;
alter table client_value_props       enable row level security;
alter table client_offers            enable row level security;
alter table client_offer_constraints enable row level security;
alter table client_assets            enable row level security;
alter table client_past_projects     enable row level security;

comment on table client_profiles is
  'Per-client brand/company/campaign knowledge the operator authors ads from. '
  '1:1 with clients. Typed columns for consistent fields; jsonb for '
  'variable-shape data (brand_fonts/warranty_details/funnel); raw_profile keeps '
  'the full source JSON. DB is canonical, seeded from + synced to '
  '/docker/hermes-shared/client-profiles/*.json. RLS deny-all per 0011.';
