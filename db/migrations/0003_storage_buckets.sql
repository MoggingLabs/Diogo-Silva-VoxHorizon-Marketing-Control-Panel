-- ============================================================================
-- 0003_storage_buckets.sql
-- ----------------------------------------------------------------------------
-- Create Supabase Storage buckets used by the control panel.
--
-- Issue: #17 (M0-17) — create Storage bucket(s)
--
-- v1 layout:
--   * `creatives` — final image PNG/JPEG/WEBP renders and final video MP4s.
--                   Voiceover audio (mp3) is stored here as an intermediate
--                   artifact during composition; the final shippable asset
--                   is the captioned MP4.
--                   Private (signed URLs only) with a 50 MiB file cap.
--
-- Intentionally NOT created here:
--   * `broll-pool` — B-roll defaults to LocalBrollStore (worker disk).
--                    The Supabase-backed pool ships only when
--                    SupabaseBrollStore is flipped on, at which point a
--                    follow-up migration provisions the bucket with its
--                    own size + MIME policy.
-- ============================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'creatives',
  'creatives',
  false,
  52428800,  -- 50 MiB
  array[
    'image/png',
    'image/jpeg',
    'image/webp',
    'video/mp4',
    'audio/mpeg',
    'audio/mp3'
  ]
)
on conflict (id) do nothing;
