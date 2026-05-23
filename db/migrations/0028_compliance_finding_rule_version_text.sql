-- 0028_compliance_finding_rule_version_text.sql
-- Make compliance_finding.rule_version TEXT so it records the engine's real,
-- semantic rule version.
--
-- The compliance engine carries a STRING version per rule (e.g. "2025.1";
-- synthesized per-client rules use "client"). compliance_finding.rule_version
-- was int, so the worker's `_coerce_rule_version` stored 0 for every
-- non-numeric version — silently destroying the version on the append-only
-- audit row. With the rule FK already removed (0027), the finding is a
-- self-describing evidence record, so it should preserve the true version
-- verbatim. Convert int -> text (existing rows, if any, keep their value as a
-- string). Worker `_coerce_rule_version` is removed; the route now stores
-- `finding.version` directly.
--
-- The compliance_rule lookup table's `version` stays int for now: it has no
-- reader yet (the engine adjudicates from the in-memory ruleset, not the
-- table) and is unseeded. When the lookup is seeded for UI display (#394),
-- make its `version` text too so the two line up.

alter table compliance_finding
  alter column rule_version type text using rule_version::text;

comment on column compliance_finding.rule_version is
  'The engine rule version verbatim (e.g. "2025.1", or "client" for synthesized '
  'per-client rules). Text so the semantic version is preserved on this '
  'append-only evidence row. Not FK''d to compliance_rule (see 0027).';
