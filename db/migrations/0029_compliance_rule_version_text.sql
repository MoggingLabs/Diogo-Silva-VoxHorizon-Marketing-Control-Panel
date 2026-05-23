-- 0029_compliance_rule_version_text.sql
-- Reconcile compliance_rule.version int -> text so the lookup matches the
-- compliance engine's SEMANTIC rule versions ("2025.1", "client", ...).
--
-- The engine (worker/src/services/compliance_rules.py via get_starter_rules())
-- carries a STRING version per rule. compliance_finding.rule_version was already
-- converted int -> text in 0028; this finishes the reconcile so the lookup PK
-- (rule_id, version) and the evidence row's (rule_id, rule_version) share one
-- representation. With this in place the table can be seeded from the in-memory
-- ruleset (the single source of truth) — see worker
-- services/compliance_rules_seed.py, run as an idempotent startup UPSERT.
--
-- Forward-only. The column is part of the primary key, so we drop + recreate the
-- PK around the type change. The partial active index
-- (compliance_rule_active_idx) is on rule_id only, so it is unaffected. Existing
-- int rows (none today — the table is unseeded) would keep their value as a
-- string via the USING cast. Guarded so a re-run is a no-op.

do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_name = 'compliance_rule'
      and column_name = 'version'
      and data_type = 'integer'
  ) then
    -- Drop the PK that includes the int `version` column...
    alter table compliance_rule
      drop constraint compliance_rule_pkey;

    -- ...convert the column (existing rows keep their value as a string)...
    alter table compliance_rule
      alter column version drop default,
      alter column version type text using version::text;

    -- ...and recreate the PK on the now-text column.
    alter table compliance_rule
      add constraint compliance_rule_pkey primary key (rule_id, version);
  end if;
end
$$;

comment on column compliance_rule.version is
  'Semantic rule version verbatim (e.g. "2025.1", or "client" for synthesized '
  'per-client rules). Text so it lines up with the engine ruleset and with '
  'compliance_finding.rule_version (0028). Seeded from get_starter_rules().';
