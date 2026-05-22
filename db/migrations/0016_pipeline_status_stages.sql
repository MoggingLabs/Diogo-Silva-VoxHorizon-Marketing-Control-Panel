-- 0016_pipeline_status_stages.sql
-- Add the 8 new pipeline stages to `pipeline_status_enum` for the 12-stage rebuild.
--
-- Current (0006): configuration, ideation, review, generation, done, cancelled.
-- Target order:   configuration -> ideation -> review -> generation
--                 -> creative_qa -> compliance_review -> copy -> spec_validation
--                 -> variant_plan -> finalize_assets -> launch_handoff -> monitor
--                 -> done (+ cancelled).
--
-- Each new value is inserted BEFORE 'done' so the enum sort order matches the
-- pipeline DAG (advanced_at / ordering reads stay meaningful). Sequential
-- "BEFORE 'done'" inserts preserve the listed order: creative_qa lands first,
-- then compliance_review after it, etc.
--
-- Postgres note: `ALTER TYPE ... ADD VALUE` is forward-only and a new value
-- cannot be USED in the same transaction that adds it. This migration only
-- ADDS the values (it never references them), so a single migration is safe on
-- PG12+. The first use of these values is in later migrations / app code.

alter type pipeline_status_enum add value if not exists 'creative_qa' before 'done';
alter type pipeline_status_enum add value if not exists 'compliance_review' before 'done';
alter type pipeline_status_enum add value if not exists 'copy' before 'done';
alter type pipeline_status_enum add value if not exists 'spec_validation' before 'done';
alter type pipeline_status_enum add value if not exists 'variant_plan' before 'done';
alter type pipeline_status_enum add value if not exists 'finalize_assets' before 'done';
alter type pipeline_status_enum add value if not exists 'launch_handoff' before 'done';
alter type pipeline_status_enum add value if not exists 'monitor' before 'done';
