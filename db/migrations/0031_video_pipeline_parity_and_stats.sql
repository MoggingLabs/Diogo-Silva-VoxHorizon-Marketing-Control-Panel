-- 0031_video_pipeline_parity_and_stats.sql
-- ----------------------------------------------------------------------------
-- Bring the video_* tables to parity with the image side for the downstream
-- gate stages (copy / finalize / monitor), and add video-specific analytics so
-- the pipeline captures the engagement + cost statistics image ads can't.
--
-- VID-12: the gate-persist handlers were image-hardwired (they wrote
-- copy_variants / creatives finalize cols / campaign_perf_image and NOTHING for
-- video). Routing video to the video_* tables needs those tables to carry the
-- same columns the handlers write, plus the richer signals short-form video
-- earns. All additive (add column if not exists / create ... if not exists), so
-- forward-only and safe to re-apply.
--
-- Launch parity (video_launch_packages gate cols) is a separate migration with
-- the launch routing -- it needs the launch_packages precondition shape.
-- ----------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- video_creatives: lineage + finalize report parity (mirror the creatives 0023
-- extends) + generation analytics. video_creatives already has drive_url +
-- duration_actual_s (0001); we add the finalize columns the finalize handler
-- writes and the cost/quality signals the operator + monitor can learn from.
-- ---------------------------------------------------------------------------
alter table video_creatives
  add column if not exists pipeline_id        uuid references pipelines (id),
  add column if not exists drive_folder_id    text,
  add column if not exists asset_name         text,            -- naming-convention output
  add column if not exists file_path_drive    text,
  add column if not exists finalized_at       timestamptz,
  add column if not exists finalize_verified  boolean not null default false,
  add column if not exists deleted_at         timestamptz,
  -- generation analytics: what it cost + how it was made (drag more stats).
  add column if not exists render_cost_usd    numeric,         -- summed kie generation spend
  add column if not exists gen_model          text,            -- e.g. veo3_fast / kling
  add column if not exists clip_count         int,             -- number of composed clips
  add column if not exists music_track_used   boolean,         -- background-music bed present
  add column if not exists broll_sources      jsonb;           -- {generated: N, stock: M}
create index if not exists video_creatives_pipeline_active_idx
  on video_creatives (pipeline_id) where deleted_at is null;

-- ---------------------------------------------------------------------------
-- video_copy_variants: parity with copy_variants so the copy handler can upsert
-- per (creative, platform, variant_index) instead of resume-by-skip, and so a
-- video creative can carry per-platform copy variants like an image creative.
-- ---------------------------------------------------------------------------
alter table video_copy_variants
  add column if not exists pipeline_id   uuid references pipelines (id),
  add column if not exists platform      text not null default 'meta',
  add column if not exists variant_index int not null default 1,
  add column if not exists placement     text,
  add column if not exists pattern       text,
  add column if not exists description   text,
  add column if not exists validation    jsonb not null default '{}'::jsonb,
  add column if not exists updated_at     timestamptz not null default now();
create unique index if not exists video_copy_variants_creative_platform_variant_idx
  on video_copy_variants (creative_id, platform, variant_index);
create index if not exists video_copy_variants_pipeline_idx
  on video_copy_variants (pipeline_id) where pipeline_id is not null;
create trigger video_copy_variants_set_updated_at
  before update on video_copy_variants for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- campaign_perf_video: link perf rows to the pipeline + ad entity (mirror the
-- campaign_perf_image 0023 extends) and add the short-form engagement funnel so
-- monitor can score video on the metrics that matter (it already has hook_rate /
-- drop_off_3s / view_rate_avg / watch_time_p50 from 0001).
-- ---------------------------------------------------------------------------
alter table campaign_perf_video
  add column if not exists pipeline_id      uuid references pipelines (id) on delete set null,
  add column if not exists ad_entity_id     uuid references ad_entity (id) on delete set null,
  -- richer engagement funnel.
  add column if not exists thruplays        int,               -- 15s (or complete) plays
  add column if not exists video_plays_3s   int,
  add column if not exists completion_p25   numeric,
  add column if not exists completion_p75   numeric,
  add column if not exists completion_p100  numeric,
  add column if not exists avg_watch_time_s numeric;
create index if not exists campaign_perf_video_pipeline_idx
  on campaign_perf_video (pipeline_id) where pipeline_id is not null;
