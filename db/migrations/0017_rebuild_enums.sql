-- 0017_rebuild_enums.sql
-- New enums for the 12-stage rebuild, plus forward-only extensions to two
-- existing enums. Separate from 0016 (status stages) and from the tables that
-- USE these values (0018+), so no new value is referenced in the txn that adds
-- it. compliance RULE ids are intentionally NOT an enum — they live in the
-- `compliance_rule` lookup table (added later) because Meta/FTC policy churns.

-- Per-creative gate machine (the four stages that run per creative).
create type creative_stage_enum as enum (
  'creative_qa', 'compliance_review', 'copy', 'spec_validation'
);

-- Per-(creative,stage) gate state. Orthogonal to creatives.status (lifecycle).
-- 'overridden' is the audited release of a 'failed' compliance unit.
create type stage_state_enum as enum (
  'pending', 'in_progress', 'passed', 'failed', 'overridden', 'skipped'
);

-- Verdict severity. 'critical' = HARD block (only a manager override releases).
create type verdict_severity_enum as enum ('info', 'low', 'medium', 'high', 'critical');

-- QA + compliance verdict outcomes (append-only evidence rows reference these).
create type qa_status_enum as enum ('pass', 'fail', 'needs_review');
create type compliance_verdict_enum as enum (
  'pending', 'pass', 'fail', 'needs_review', 'override_released'
);

-- Per-placement spec-validation outcome.
create type spec_status_enum as enum ('pending', 'pass', 'warn', 'fail', 'exception');

-- Copy variant lifecycle (rebuilt copy_variants uses this).
create type copy_variant_status_enum as enum (
  'draft', 'validated', 'approved', 'rejected', 'retired'
);

-- Launch package lifecycle (gate states for launch_handoff).
create type launch_package_status_enum as enum (
  'assembling', 'validating', 'blocked', 'ready', 'approved',
  'queued', 'live', 'failed', 'cancelled'
);

-- Ad platform + placement (copy variants, spec checks, ad entities).
create type platform_enum as enum ('meta', 'google', 'tiktok');
create type placement_enum as enum (
  'feed', 'stories', 'reels', 'marketplace', 'search', 'display', 'pmax'
);

-- Meta ad-entity graph (recorded after the operator's PAUSED-first MCP creates).
create type ad_entity_kind_enum as enum ('campaign', 'adset', 'ad', 'creative');
create type ad_entity_state_enum as enum ('paused', 'active', 'archived', 'deleted', 'error');

-- Unified cost ledger categories (Kie/codex generation + Meta spend).
create type cost_kind_enum as enum (
  'image_gen', 'video_gen', 'vision_qa', 'copy_llm', 'meta_spend', 'other'
);

-- Extend existing enums (forward-only; not used in this txn).
-- iteration_author gains 'operator' (the operator currently masquerades as
-- 'ekko' in jsonb) and 'system' (trigger/backfill writes).
alter type iteration_author add value if not exists 'operator';
alter type iteration_author add value if not exists 'system';

-- ratio gains the Meta-preferred 4:5 feed crop and Google's 1.91:1 landscape.
alter type ratio add value if not exists '4x5';
alter type ratio add value if not exists '1.91x1';
