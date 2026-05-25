-- 0049_brief_soft_delete.sql
-- ----------------------------------------------------------------------------
-- Makeover M3 (E3.2 / #591): give `briefs` and `video_briefs` a `deleted_at`
-- tombstone so the operator can ARCHIVE (soft-delete) a brief from the unified
-- Briefs section and RESTORE it later, instead of having no removal path at all.
--
-- Context: the M1 soft-delete migration (0047) deliberately skipped briefs and
-- video_briefs on the assumption (see its header comment) that they "already
-- carry deleted_at" the way creatives (0023) and video_creatives (0031) do.
-- They do NOT -- neither the initial schema (0001) nor any later migration ever
-- added the column to either brief table. M3's archive/restore epic needs it,
-- so it lands here, forward-only, consistent with the "delete = soft-delete"
-- guardrail and the per-table tombstones in 0047/0048.
--
-- Why soft, not hard: a brief is the root of a creative lineage (creatives /
-- video_creatives reference it ON DELETE CASCADE, launch packages + pipelines
-- reference it by FK). A hard delete would destroy that history. Soft-archive
-- sets `deleted_at`, hides the row from the active list, preserves the audit
-- trail, and is reversible.
--
-- Additive + idempotent (add column if not exists / create index if not
-- exists). Forward-only: never edited once merged.
-- ----------------------------------------------------------------------------

-- image briefs --------------------------------------------------------------
alter table briefs
  add column if not exists deleted_at timestamptz;

-- Partial index for the active-list query (`deleted_at is null`, newest-first),
-- the default read path for the unified Briefs list + the list API.
create index if not exists briefs_active_idx
  on briefs (created_at desc) where deleted_at is null;

-- video briefs --------------------------------------------------------------
alter table video_briefs
  add column if not exists deleted_at timestamptz;

create index if not exists video_briefs_active_idx
  on video_briefs (created_at desc) where deleted_at is null;
