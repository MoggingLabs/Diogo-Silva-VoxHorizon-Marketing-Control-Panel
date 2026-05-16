-- ============================================================================
-- 0001_initial_schema.sql
-- ----------------------------------------------------------------------------
-- Initial Postgres schema for the VoxHorizon Marketing Control Panel.
--
-- Issue: #16 (M0-16) — initial Supabase database schema migration
-- Covers both verticals (image + video) plus shared utilities.
--
-- RLS is intentionally OFF for v1 — single-operator app behind Tailscale.
-- See ARCHITECTURE.md for the security model.
--
-- Migrations are forward-only. Never edit this file after merge; new
-- changes go into a new numbered migration.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Extensions
-- ---------------------------------------------------------------------------
create extension if not exists "pgcrypto";
create extension if not exists "pg_trgm";

-- ---------------------------------------------------------------------------
-- 2. Enum types
-- ---------------------------------------------------------------------------

create type service_type as enum ('roofing', 'remodeling');

create type brief_status as enum (
  'draft',
  'posted',
  'approved',
  'approved_with_changes',
  'rejected'
);

-- Used for any cross-format reads where the format matters at the row level.
create type creative_type as enum ('image', 'video');

create type image_creative_status as enum (
  'draft',
  'approved',
  'rejected',
  'live',
  'killed'
);

create type ratio as enum ('1x1', '9x16', '16x9');

create type iteration_author as enum ('user', 'ekko');

create type image_iteration_kind as enum (
  'generate',
  'regenerate',
  'annotate',
  'comment',
  'user_edit'
);

create type ad_verdict as enum ('kill', 'watch', 'keep');

create type sync_status as enum ('running', 'ok', 'error');

-- Video-specific enums
create type video_brief_status as enum (
  'draft',
  'posted',
  'approved',
  'approved_with_changes',
  'rejected'
);

create type video_creative_status as enum (
  'draft',
  'script_ready',
  'voiceover_ready',
  'broll_ready',
  'composed',
  'captioned',
  'approved',
  'rejected'
);

create type video_iteration_kind as enum (
  'generate_script',
  'regenerate_voiceover',
  'search_broll',
  'swap_broll',
  'rerender',
  'recaption',
  'comment',
  'user_edit'
);

create type broll_store_backend as enum ('local', 'supabase');

-- ---------------------------------------------------------------------------
-- 3. Image-side tables
-- ---------------------------------------------------------------------------

-- clients ---------------------------------------------------------------
create table clients (
  id                    uuid primary key default gen_random_uuid(),
  slug                  text unique not null,
  name                  text not null,
  service_type          service_type not null,
  brand_colors          jsonb default '{}'::jsonb,
  meta_account_id       text,
  ghl_location_id       text,
  drive_root_folder_id  text,
  cpl_target            numeric,
  status                text not null default 'active',
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

-- briefs ----------------------------------------------------------------
create table briefs (
  id              uuid primary key default gen_random_uuid(),
  brief_id_human  text unique not null,
  client_id       uuid references clients(id),
  status          brief_status not null default 'draft',
  payload         jsonb not null
                    check (payload ? 'service' and payload ? 'budget'),
  created_at      timestamptz not null default now(),
  posted_at       timestamptz,
  decided_at      timestamptz,
  decided_notes   text,
  decided_by      text
);
create index on briefs (client_id, status);

-- creatives (image) -----------------------------------------------------
create table creatives (
  id                  uuid primary key default gen_random_uuid(),
  brief_id            uuid not null references briefs(id) on delete cascade,
  type                creative_type not null default 'image',
  concept             text,
  offer_text          text,
  ratio               ratio,
  version             text not null default 'v1.0',
  file_path_supabase  text,
  file_path_drive     text,
  prompt_used         jsonb,
  status              image_creative_status not null default 'draft',
  created_at          timestamptz not null default now(),
  approved_at         timestamptz
);
create index on creatives (brief_id);

-- creative_iterations (image) ------------------------------------------
create table creative_iterations (
  id                  uuid primary key default gen_random_uuid(),
  creative_id         uuid not null references creatives(id) on delete cascade,
  parent_creative_id  uuid references creatives(id),
  author              iteration_author not null,
  kind                image_iteration_kind not null,
  content             jsonb,
  image_path_supabase text,
  created_at          timestamptz not null default now()
);
create index on creative_iterations (creative_id, created_at desc);

-- copy_variants (image) -------------------------------------------------
-- Decision: keep one `copy_variants` table referencing image `creatives`,
-- and a separate `video_copy_variants` table for the video side.
-- (Polymorphic single-table option rejected to keep FK integrity tight.)
create table copy_variants (
  id          uuid primary key default gen_random_uuid(),
  creative_id uuid not null references creatives(id) on delete cascade,
  headline    text,
  body        text,
  cta         text,
  humanized   boolean default false,
  status      text default 'draft',
  created_at  timestamptz not null default now()
);

-- launch_packages (image) -----------------------------------------------
create table launch_packages (
  id              uuid primary key default gen_random_uuid(),
  brief_id        uuid not null references briefs(id),
  status          text not null default 'validating',
  payload         jsonb not null,
  created_at      timestamptz not null default now(),
  decided_at      timestamptz,
  decided_notes   text
);

-- ---------------------------------------------------------------------------
-- 4. Video-side tables
-- ---------------------------------------------------------------------------

-- video_briefs ----------------------------------------------------------
create table video_briefs (
  id                    uuid primary key default gen_random_uuid(),
  brief_id_human        text unique not null,
  client_id             uuid references clients(id),
  status                video_brief_status not null default 'draft',
  script_outline        jsonb,
  target_duration_s     int,
  voice_id              text,
  music_track           text,
  hook_style            text,
  dimensions            ratio default '9x16',
  captions_style        text,
  broll_selection_mode  text not null default 'review_each'
    check (broll_selection_mode in ('auto', 'review_each', 'review_low_confidence')),
  payload               jsonb default '{}'::jsonb,
  created_at            timestamptz not null default now(),
  posted_at             timestamptz,
  decided_at            timestamptz,
  decided_notes         text,
  decided_by            text
);
create index on video_briefs (client_id, status);

-- video_creatives -------------------------------------------------------
create table video_creatives (
  id                  uuid primary key default gen_random_uuid(),
  brief_id            uuid not null references video_briefs(id) on delete cascade,
  version             int not null default 1,
  script_path         text,
  voiceover_path      text,
  -- broll_clips: array of objects with shape:
  --   { segment_idx, store_backend, clip_id, in_s, out_s, source_url }
  -- store_backend is one of broll_store_backend enum values.
  broll_clips         jsonb,
  composed_path       text,
  captioned_path      text,
  drive_url           text,
  duration_actual_s   int,
  status              video_creative_status not null default 'draft',
  created_at          timestamptz not null default now(),
  approved_at         timestamptz
);
create index on video_creatives (brief_id);

-- video_iterations ------------------------------------------------------
create table video_iterations (
  id                  uuid primary key default gen_random_uuid(),
  creative_id         uuid not null references video_creatives(id) on delete cascade,
  parent_creative_id  uuid references video_creatives(id),
  author              iteration_author not null,
  kind                video_iteration_kind not null,
  content             jsonb,
  image_path_supabase text,
  created_at          timestamptz not null default now()
);
create index on video_iterations (creative_id, created_at desc);

-- video_copy_variants ---------------------------------------------------
create table video_copy_variants (
  id          uuid primary key default gen_random_uuid(),
  creative_id uuid not null references video_creatives(id) on delete cascade,
  headline    text,
  body        text,
  cta         text,
  humanized   boolean default false,
  status      text default 'draft',
  created_at  timestamptz not null default now()
);

-- video_launch_packages -------------------------------------------------
create table video_launch_packages (
  id              uuid primary key default gen_random_uuid(),
  brief_id        uuid not null references video_briefs(id),
  status          text not null default 'validating',
  payload         jsonb not null,
  created_at      timestamptz not null default now(),
  decided_at      timestamptz,
  decided_notes   text
);

-- ---------------------------------------------------------------------------
-- 5. Audit tables (split image vs. video, plus union view)
-- ---------------------------------------------------------------------------

-- campaign_perf_image ---------------------------------------------------
create table campaign_perf_image (
  id              uuid primary key default gen_random_uuid(),
  client_id       uuid references clients(id),
  campaign_id     text not null,
  window_days     int not null,
  spend           numeric,
  impressions     int,
  clicks          int,
  ctr             numeric,
  leads_meta      int,
  leads_ghl       int,
  cpl_real        numeric,
  freq            numeric,
  verdict         ad_verdict,
  verdict_reason  text,
  pulled_at       timestamptz not null default now(),
  unique (client_id, campaign_id, window_days, (date_trunc('day', pulled_at)))
);
create index on campaign_perf_image (client_id, pulled_at desc);

-- campaign_perf_video ---------------------------------------------------
-- Video has additional engagement metrics that don't apply to static images.
create table campaign_perf_video (
  id              uuid primary key default gen_random_uuid(),
  client_id       uuid references clients(id),
  campaign_id     text not null,
  window_days     int not null,
  spend           numeric,
  impressions     int,
  clicks          int,
  ctr             numeric,
  leads_meta      int,
  leads_ghl       int,
  cpl_real        numeric,
  freq            numeric,
  hook_rate       numeric,
  drop_off_3s     numeric,
  view_rate_avg   numeric,
  watch_time_p50  numeric,
  verdict         ad_verdict,
  verdict_reason  text,
  pulled_at       timestamptz not null default now(),
  unique (client_id, campaign_id, window_days, (date_trunc('day', pulled_at)))
);
create index on campaign_perf_video (client_id, pulled_at desc);

-- v_campaign_perf -------------------------------------------------------
-- UNION view exposes the common subset of fields tagged with format.
-- Use this for dashboards that mix image + video performance side-by-side.
create or replace view v_campaign_perf as
  select
    id,
    client_id,
    campaign_id,
    window_days,
    'image'::text as format,
    spend,
    impressions,
    clicks,
    ctr,
    leads_meta,
    leads_ghl,
    cpl_real,
    freq,
    verdict,
    verdict_reason,
    pulled_at
  from campaign_perf_image
  union all
  select
    id,
    client_id,
    campaign_id,
    window_days,
    'video'::text as format,
    spend,
    impressions,
    clicks,
    ctr,
    leads_meta,
    leads_ghl,
    cpl_real,
    freq,
    verdict,
    verdict_reason,
    pulled_at
  from campaign_perf_video;

-- ---------------------------------------------------------------------------
-- 6. Shared utilities
-- ---------------------------------------------------------------------------

-- events: lightweight append-only audit log for arbitrary domain events.
create table events (
  id          uuid primary key default gen_random_uuid(),
  kind        text not null,
  ref_table   text,
  ref_id      uuid,
  payload     jsonb,
  created_at  timestamptz not null default now()
);
create index on events (kind, created_at desc);

-- overrides: operator corrections layered on top of any table via left-join.
-- (table_name, row_id, field_name) is unique; corrected_value is the
-- post-edit value used at read time.
create table overrides (
  id              uuid primary key default gen_random_uuid(),
  table_name      text not null,
  row_id          text not null,
  field_name      text not null,
  corrected_value jsonb not null,
  edited_by       text not null default 'operator',
  edited_at       timestamptz not null default now(),
  unique (table_name, row_id, field_name)
);
create index on overrides (table_name, row_id);

-- sync_log: cron / worker audit trail. One row per sync run.
create table sync_log (
  id            uuid primary key default gen_random_uuid(),
  source        text not null,
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  rows_upserted int,
  status        sync_status not null default 'running',
  error_text    text,
  payload       jsonb
);
create index on sync_log (source, started_at desc);

-- push_subscriptions: Web Push subscription endpoints for the operator.
create table push_subscriptions (
  id          uuid primary key default gen_random_uuid(),
  endpoint    text not null,
  keys        jsonb not null,
  created_at  timestamptz not null default now(),
  last_seen   timestamptz
);

-- ---------------------------------------------------------------------------
-- 7. Helper functions
-- ---------------------------------------------------------------------------

-- gen_brief_id_human(slug)
--   Returns a daily-scoped human-readable brief id, e.g. "acme-2026-05-16-001".
--   Sequence is scoped to (client_slug, calendar day UTC).
create or replace function gen_brief_id_human(p_client_slug text)
returns text
language plpgsql
as $$
declare
  base text := p_client_slug || '-' || to_char(now() at time zone 'utc', 'YYYY-MM-DD');
  seq  int;
begin
  select coalesce(max(substring(brief_id_human from length(base) + 2)::int), 0) + 1
    into seq
    from briefs
    where brief_id_human like base || '-%';
  return base || '-' || lpad(seq::text, 3, '0');
end
$$;

-- gen_video_brief_id_human(slug)
--   Same as above for the video side. Prefix is "vid-" to keep the two
--   namespaces visually separated.  Example: "vid-acme-2026-05-16-001".
create or replace function gen_video_brief_id_human(p_client_slug text)
returns text
language plpgsql
as $$
declare
  base text := 'vid-' || p_client_slug || '-' || to_char(now() at time zone 'utc', 'YYYY-MM-DD');
  seq  int;
begin
  select coalesce(max(substring(brief_id_human from length(base) + 2)::int), 0) + 1
    into seq
    from video_briefs
    where brief_id_human like base || '-%';
  return base || '-' || lpad(seq::text, 3, '0');
end
$$;
