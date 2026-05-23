-- 0027_drop_compliance_finding_rule_fk.sql
-- Drop the FK from compliance_finding to the versioned compliance_rule lookup.
--
-- compliance_finding is APPEND-ONLY, tamper-evident audit evidence: each row
-- records exactly what fired (rule_id, rule_version, severity, evidence,
-- required_edit, citation_url, checked_by). The compliance engine adjudicates
-- from the IN-MEMORY ruleset (worker/src/services/compliance_rules.py via
-- get_starter_rules()) — it never reads the compliance_rule TABLE — so that
-- table is a display/lookup surface only, and is not seeded in a fresh DB.
--
-- Hard-FK'ing append-only evidence to a mutable, versioned lookup is the wrong
-- coupling:
--   1. a rule later deactivated or re-versioned must NOT orphan or break
--      historical evidence (the whole point of append-only audit rows);
--   2. the engine's rule version is a string ("2025.1") while the finding
--      column + lookup PK are int, so worker `_coerce_rule_version()` stores 0
--      and the FK can never be satisfied — against an unseeded lookup the insert
--      hard-fails (23503), stalling compliance_review for every pipeline.
--
-- Drop the FK; the finding row stays self-contained and self-describing.
-- (Seeding compliance_rule for UI display + reconciling the version type are
-- tracked separately and are not required for the compliance verdict path.)

alter table compliance_finding
  drop constraint if exists compliance_finding_rule_id_rule_version_fkey;
