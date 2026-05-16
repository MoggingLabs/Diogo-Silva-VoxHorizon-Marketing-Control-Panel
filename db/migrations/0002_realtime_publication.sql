-- ============================================================================
-- 0002_realtime_publication.sql
-- ----------------------------------------------------------------------------
-- Enable Supabase Realtime on all user-visible tables so the operator UI
-- can subscribe to live updates (brief decisions, creative iterations,
-- launch packages, audit verdicts, override edits).
--
-- Issue: #17 (M0-17) — enable Supabase Realtime publication
--
-- Excluded by design:
--   - `events`     — high-volume internal audit log; subscribe selectively
--                    via filtered Realtime channels if/when needed.
--   - `sync_log`   — cron telemetry; not useful in the UI live-feed.
-- ============================================================================

alter publication supabase_realtime add table briefs;
alter publication supabase_realtime add table creatives;
alter publication supabase_realtime add table creative_iterations;
alter publication supabase_realtime add table copy_variants;
alter publication supabase_realtime add table launch_packages;

alter publication supabase_realtime add table video_briefs;
alter publication supabase_realtime add table video_creatives;
alter publication supabase_realtime add table video_iterations;
alter publication supabase_realtime add table video_copy_variants;
alter publication supabase_realtime add table video_launch_packages;

alter publication supabase_realtime add table campaign_perf_image;
alter publication supabase_realtime add table campaign_perf_video;

alter publication supabase_realtime add table overrides;
