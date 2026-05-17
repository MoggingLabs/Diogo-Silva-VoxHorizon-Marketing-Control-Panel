-- ============================================================================
-- 0006_pipelines.sql
-- ----------------------------------------------------------------------------
-- Pipeline / Ad Factory state machine.
--
-- Issue: #171 (PF-A-1) — DB migration for pipelines + pipeline_events tables
--
-- The "Pipeline" feature is a guided multi-step ad-creation flow:
--
--   configuration → ideation → review → generation → done
--                                                  ↘ cancelled
--
-- Every other table (briefs, video_briefs, launch_packages, etc.) stays
-- as-is and is referenced from `pipelines` by FK. A pipeline points at:
--   * an image_brief_id (when format_choice is 'image' or 'both'),
--   * a video_brief_id (when format_choice is 'video' or 'both'),
--   * a launch_package_id (image-side, populated at handoff).
--
-- `pipeline_events` is an append-only audit/timeline log scoped to a
-- single pipeline (kind = stage_advanced / stage_rejected / pick_made /
-- approval_recorded / etc.). It is intentionally separate from the
-- top-level `events` table so per-pipeline timelines can be queried with
-- a single indexed lookup and pipeline-only Realtime subscriptions are
-- not polluted with other domain events.
--
-- RLS stays OFF (single-operator app behind Tailscale — see ARCHITECTURE.md).
--
-- Forward-only: never edit a merged migration. New refinements go into a
-- new numbered file.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Enum types
-- ---------------------------------------------------------------------------

create type pipeline_status_enum as enum (
  'configuration',
  'ideation',
  'review',
  'generation',
  'done',
  'cancelled'
);

create type pipeline_format_enum as enum ('image', 'video', 'both');

-- ---------------------------------------------------------------------------
-- 2. pipelines
-- ---------------------------------------------------------------------------
-- One row per Pipeline run. `format_choice` is locked at creation; the
-- stage advances forward via `pipeline_events(kind='stage_advanced')`.
-- jsonb columns are intentionally loose — schemas live in the app layer
-- (lib/pipeline/schemas.ts) and may evolve as ideation/review UIs mature.
--
-- `advanced_at` is a jsonb map of `{ <stage>: <iso timestamp> }` so the
-- UI can show "how long was this in <stage>" without scanning the events
-- table. The events table remains the source of truth; this is a
-- denormalized cache populated alongside each `stage_advanced` write.

create table pipelines (
  id                  uuid primary key default gen_random_uuid(),
  status              pipeline_status_enum not null default 'configuration',
  format_choice       pipeline_format_enum not null,
  client_id           uuid references clients(id),
  image_brief_id      uuid references briefs(id),
  video_brief_id      uuid references video_briefs(id),
  config_draft        jsonb not null default '{}'::jsonb,
  picks               jsonb not null default '{}'::jsonb,
  cost_estimate       jsonb,
  cost_actual         jsonb,
  approval            jsonb,
  launch_package_id   uuid references launch_packages(id),
  advanced_at         jsonb not null default '{}'::jsonb,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- Active-only index: most dashboard queries filter on "not done". A partial
-- index on the status column keeps it tiny as completed pipelines accumulate.
create index pipelines_active_status_idx
  on pipelines (status)
  where status <> 'done';

create index pipelines_client_id_idx on pipelines (client_id);

-- Foreign-key lookup indexes — both for brief→pipeline reverse-lookups
-- (lib/pipeline/lookup.ts) and to avoid sequential scans when a brief is
-- deleted (FK validation).
create index pipelines_image_brief_id_idx
  on pipelines (image_brief_id)
  where image_brief_id is not null;

create index pipelines_video_brief_id_idx
  on pipelines (video_brief_id)
  where video_brief_id is not null;

-- ---------------------------------------------------------------------------
-- 3. pipeline_events
-- ---------------------------------------------------------------------------
-- Append-only timeline per pipeline. `kind` is free-form text (e.g.
-- `stage_advanced`, `stage_rejected`, `pick_made`, `approval_recorded`,
-- `cancelled`); `stage` is the pipeline_status_enum value the event is
-- about (typically the destination stage for stage_advanced).
--
-- ON DELETE CASCADE — the timeline has no value once the parent pipeline
-- is gone (operator-deleted pipelines are vanishingly rare; the event
-- log is for live debugging and post-run review, not long-term audit;
-- the top-level `events` table covers cross-pipeline domain auditing).

create table pipeline_events (
  id            uuid primary key default gen_random_uuid(),
  pipeline_id   uuid not null references pipelines(id) on delete cascade,
  kind          text not null,
  stage         pipeline_status_enum,
  payload       jsonb,
  created_at    timestamptz not null default now()
);

-- Primary timeline lookup: load events for one pipeline newest-first.
create index pipeline_events_pipeline_id_created_at_idx
  on pipeline_events (pipeline_id, created_at desc);

-- ---------------------------------------------------------------------------
-- 4. Realtime publication
-- ---------------------------------------------------------------------------
-- Both tables are user-visible: `pipelines` drives the Pipeline list /
-- stepper, `pipeline_events` drives the timeline pane. Adding to the
-- existing `supabase_realtime` publication lets the UI subscribe to
-- per-row updates with the same pattern as briefs/creatives.

alter publication supabase_realtime add table pipelines;
alter publication supabase_realtime add table pipeline_events;
