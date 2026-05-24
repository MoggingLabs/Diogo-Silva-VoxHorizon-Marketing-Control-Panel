# 0003. Single source of truth per invariant

- Status: Accepted
- Date: 2026-05-24
- Deciders: @pveloso01

## Context

Several invariants are currently expressed in more than one place, and the
copies drift:

- The stage list lives implicitly in the status enum, again in the
  transition logic, and again in UI phase mapping.
- The rollup clearance predicate is restated in the trigger, the advance
  route, and the UI gate (see ADR-0002).
- Types are hand-rolled in `lib/pipeline/types.ts` alongside the generated
  `lib/supabase/types.gen.ts`, so an enum can change in the database
  without the hand-written unions noticing.
- Pricing and the compliance ruleset are referenced from multiple call
  sites.

When the same fact has two homes, a change to one and not the other is a
silent bug that type-checking and tests do not always catch.

## Decision

We will give each cross-cutting invariant exactly one authoritative home,
generate or derive every downstream copy from it, and add drift gates in
CI that fail the build when a copy diverges.

- Stage list: one stage-list manifest is canonical; the status enum,
  transition table, and UI phase mapping derive from it.
- Rollup predicate: one SQL function (per ADR-0002); all callers read it.
- Types: `lib/supabase/types.gen.ts` is generated from the live schema;
  the hand-rolled pipeline unions are derived from it, not maintained in
  parallel.
- Pricing and compliance rules: each has one source (the cost ledger
  source and the versioned `compliance_rule` data, surfaced through
  `worker/src/services/compliance_rules.py`); call sites read from it.

A drift gate checks each generated or derived artifact against its source
on every PR, and a failing drift gate blocks merge. The
single-source-of-truth artifacts are assigned review owners in CODEOWNERS
so changes to them are seen.

## Consequences

- Changing an invariant is a single edit plus a regenerate, not a hunt for
  every copy. The regenerated artifacts are committed so reviewers and CI
  see the full effect.
- Drift becomes a build failure instead of a runtime surprise. This adds a
  codegen and drift-check step to CI and a discipline of regenerating
  after schema changes.
- The canonical artifacts (`db/migrations/**`, the generated types, the
  compliance rules module, the stage-list manifest once it lands) carry
  CODEOWNERS review ownership; edits to them require explicit sign-off.
- A modest amount of generator and drift-gate tooling must be built and
  maintained. That cost is paid once and prevents a recurring class of
  desync bugs.
