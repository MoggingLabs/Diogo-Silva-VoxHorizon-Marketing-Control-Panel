-- ============================================================================
-- 0004_v1_video_brief_constraints.sql
-- ----------------------------------------------------------------------------
-- V1-1: enforce required fields on POSTED video briefs.
--
-- Issue: #78 (V1-1) — video_briefs schema refinements
--
-- target_duration_s and voice_id can be null while a brief is still in the
-- `draft` status (operator is still composing it), but once it transitions to
-- any non-draft status (`posted`, `approved`, `approved_with_changes`,
-- `rejected`) those fields must be set. The status enum and the
-- `gen_video_brief_id_human` helper were both introduced in 0001 — this
-- migration only layers on the CHECK constraint.
--
-- Forward-only: never edit a merged migration. New refinements go into a
-- new numbered file.
-- ============================================================================

alter table video_briefs
  add constraint video_briefs_required_when_posted check (
    status = 'draft' or
    (target_duration_s is not null and voice_id is not null)
  );
