-- 0047_soft_delete_safe_tables.sql
-- ----------------------------------------------------------------------------
-- Makeover M1 (E1.2 / #584): give the SAFE, operator-managed tables a
-- `deleted_at` tombstone so the reusable CRUD stack (lib/crud/soft-delete) can
-- archive + restore them instead of hard-deleting. "Delete = soft-delete" is a
-- plan guardrail; the neutral `creative` base (0034) and creatives /
-- video_creatives / briefs / video_briefs already carry `deleted_at`, so they
-- are deliberately NOT touched here.
--
-- SAFE = user-facing artifacts the operator creates/edits/retires:
--   clients + the client config children (profile / services / value props /
--   offers / offer constraints / assets / past projects / integrations),
--   copy variants (image + video), the A/B variant plan, the launch packages
--   (image + video), and concepts.
--
-- NOT included (by design):
--   - append-only audit (events / pipeline_events / qa_result /
--     approval_mode_audit): immutable, 0041 revokes UPDATE/DELETE; "delete" is a
--     new corrective row, never a tombstone.
--   - override-mutable gate rows (compliance_finding / spec_check /
--     creative_stage_state): mutated only via their decision/override routes.
--   - derived / worker-owned (campaign_perf_* / cost_ledger / ad_entity): read +
--     overlay edits, never a tombstone on the source row.
--   - pure plumbing / outbox / dispatch tables.
--
-- Additive + idempotent (add column if not exists / create index if not
-- exists). Forward-only: never edited once merged.
-- ----------------------------------------------------------------------------

-- clients -------------------------------------------------------------------
alter table clients
  add column if not exists deleted_at timestamptz;
create index if not exists clients_active_idx
  on clients (created_at desc) where deleted_at is null;

-- client config: profile (1:1) + children -----------------------------------
alter table client_profiles
  add column if not exists deleted_at timestamptz;

alter table client_services
  add column if not exists deleted_at timestamptz;
create index if not exists client_services_active_idx
  on client_services (client_id) where deleted_at is null;

alter table client_value_props
  add column if not exists deleted_at timestamptz;
create index if not exists client_value_props_active_idx
  on client_value_props (client_id) where deleted_at is null;

alter table client_offers
  add column if not exists deleted_at timestamptz;
create index if not exists client_offers_active_idx
  on client_offers (client_id) where deleted_at is null;

alter table client_offer_constraints
  add column if not exists deleted_at timestamptz;
create index if not exists client_offer_constraints_active_idx
  on client_offer_constraints (client_id) where deleted_at is null;

alter table client_assets
  add column if not exists deleted_at timestamptz;
create index if not exists client_assets_active_idx
  on client_assets (client_id) where deleted_at is null;

alter table client_past_projects
  add column if not exists deleted_at timestamptz;
create index if not exists client_past_projects_active_idx
  on client_past_projects (client_id) where deleted_at is null;

alter table client_integrations
  add column if not exists deleted_at timestamptz;
create index if not exists client_integrations_active_idx
  on client_integrations (client_id) where deleted_at is null;

-- copy variants (image + video) ---------------------------------------------
alter table copy_variants
  add column if not exists deleted_at timestamptz;
create index if not exists copy_variants_active_idx
  on copy_variants (creative_id) where deleted_at is null;

alter table video_copy_variants
  add column if not exists deleted_at timestamptz;
create index if not exists video_copy_variants_active_idx
  on video_copy_variants (creative_id) where deleted_at is null;

-- A/B variant plan ----------------------------------------------------------
alter table variant_plan
  add column if not exists deleted_at timestamptz;
create index if not exists variant_plan_active_idx
  on variant_plan (pipeline_id) where deleted_at is null;

-- launch packages (image + video) -------------------------------------------
alter table launch_packages
  add column if not exists deleted_at timestamptz;
create index if not exists launch_packages_active_idx
  on launch_packages (brief_id) where deleted_at is null;

alter table video_launch_packages
  add column if not exists deleted_at timestamptz;
create index if not exists video_launch_packages_active_idx
  on video_launch_packages (brief_id) where deleted_at is null;

-- concepts ------------------------------------------------------------------
alter table concepts
  add column if not exists deleted_at timestamptz;
create index if not exists concepts_active_idx
  on concepts (brief_id) where deleted_at is null;
