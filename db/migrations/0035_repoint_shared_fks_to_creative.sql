-- 0035_repoint_shared_fks_to_creative.sql
-- ----------------------------------------------------------------------------
-- M1 (#448) keystone, EXPAND phase (part 2 of 2).
--
-- Repoint every SHARED gate / evidence / launch / cost table's creative_id FK
-- from creatives(id) to the neutral creative(id) base (populated in 0034). After
-- this, a VIDEO creative finally has a valid home in the gate: its id exists in
-- `creative` (mirrored by the 0034 trigger/backfill), so the FK accepts it.
--
-- Per-vertical tables (creative_iterations, copy_variants and their video_*
-- twins) are NOT repointed: they belong to one vertical and keep their own-table
-- FKs. On-delete semantics are preserved per table (cascade for gate/evidence,
-- set null for variant_plan_cell + cost_ledger, no-action for ad_entity).
--
-- Constraint names are the Postgres auto-generated `<table>_creative_id_fkey`
-- (the same convention 0027 relied on). Forward-only.
-- ----------------------------------------------------------------------------

alter table creative_stage_state
  drop constraint if exists creative_stage_state_creative_id_fkey,
  add  constraint creative_stage_state_creative_id_fkey
       foreign key (creative_id) references creative (id) on delete cascade;

alter table qa_result
  drop constraint if exists qa_result_creative_id_fkey,
  add  constraint qa_result_creative_id_fkey
       foreign key (creative_id) references creative (id) on delete cascade;

alter table compliance_finding
  drop constraint if exists compliance_finding_creative_id_fkey,
  add  constraint compliance_finding_creative_id_fkey
       foreign key (creative_id) references creative (id) on delete cascade;

alter table spec_check
  drop constraint if exists spec_check_creative_id_fkey,
  add  constraint spec_check_creative_id_fkey
       foreign key (creative_id) references creative (id) on delete cascade;

alter table pipeline_work_units
  drop constraint if exists pipeline_work_units_creative_id_fkey,
  add  constraint pipeline_work_units_creative_id_fkey
       foreign key (creative_id) references creative (id) on delete cascade;

alter table variant_plan_cell
  drop constraint if exists variant_plan_cell_creative_id_fkey,
  add  constraint variant_plan_cell_creative_id_fkey
       foreign key (creative_id) references creative (id) on delete set null;

alter table ad_entity
  drop constraint if exists ad_entity_creative_id_fkey,
  add  constraint ad_entity_creative_id_fkey
       foreign key (creative_id) references creative (id);

alter table cost_ledger
  drop constraint if exists cost_ledger_creative_id_fkey,
  add  constraint cost_ledger_creative_id_fkey
       foreign key (creative_id) references creative (id) on delete set null;
