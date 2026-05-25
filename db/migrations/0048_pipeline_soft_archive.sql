-- 0048_pipeline_soft_archive.sql
-- ----------------------------------------------------------------------------
-- Makeover (#609): give `pipelines` a `deleted_at` tombstone so the operator
-- can ARCHIVE (soft-delete) a run from the dashboard and RESTORE it later,
-- instead of only CANCELLING it (a status flip that keeps it in the list).
--
-- Why soft, not hard: a pipeline is the orchestration root. `pipeline_events`
-- references it ON DELETE CASCADE and `creatives.pipeline_id` ON DELETE SET
-- NULL, so a hard delete would destroy the run's timeline. Soft-archive sets
-- `deleted_at`, hides the row from the active list, preserves the audit trail,
-- and is reversible -- consistent with the makeover's "delete = soft-delete"
-- guardrail (see 0047 for the other safe tables; `pipelines` was deliberately
-- excluded there as the orchestration root, and gets its tombstone here).
--
-- A permanent hard-delete is intentionally out of scope (possible later
-- follow-up).
--
-- Additive + idempotent (add column if not exists / create index if not
-- exists). Forward-only: never edited once merged.
-- ----------------------------------------------------------------------------

alter table pipelines
  add column if not exists deleted_at timestamptz;

-- Partial index for the active-list query (`deleted_at is null`, newest-first),
-- which is the default read path for the pipeline index page + the list API.
create index if not exists pipelines_active_idx
  on pipelines (created_at desc) where deleted_at is null;
