# 0002. DB-enforced gates plus an adjudicator role

- Status: Accepted
- Date: 2026-05-24
- Deciders: @pveloso01

## Context

The pipeline advances a stage only when every picked, non-killed creative
has cleared that stage. In the current system advancement is decided by an
event-count heuristic in a trigger, and the same clearance logic is also
re-expressed in the advance route and in the UI gate. Three problems
follow:

- The heuristic let an all-failed generation batch reach `done`, because
  it counted task events rather than checking real per-creative state.
- The advance route, the UI, and the trigger can disagree, because each
  carries its own copy of "is this gate cleared".
- The agent operator runs the stage work and can also write the result
  that clears the gate. Nothing in the database stops the operator from
  self-clearing a hard gate such as compliance or launch. The intended
  invariant, that only an audited human releases a hard gate, lives only in
  convention.

## Decision

We will make the database the single authority for gate clearance and
advancement.

- A single SQL predicate, `pipeline_rollup_cleared(pipeline_id, stage)`,
  is the one definition of "this gate is open": every picked, non-killed
  creative for that stage is in `passed`, `overridden`, or `skipped`. The
  advance route and the UI gate both read this predicate so they agree by
  construction (see ADR-0003).
- Advancement happens through a `SECURITY DEFINER` advance RPC that
  re-checks the predicate inside the transaction and applies the stage
  transition with compare-and-set. Code never advances by counting events.
- Gate clearance rows are writable only by an adjudicator role. The agent
  operator has no tool and no grant that writes a `passed` verdict or
  clears a gate; for hard gates (compliance, launch) only an audited
  adjudicator action releases the block, and the original failing evidence
  is retained append-only.

## Consequences

- An all-failed or partially-failed batch cannot advance: the rollup
  predicate is false until every unit is genuinely cleared, so the
  no-stall and no-false-advance invariants hold at the database level.
- The operator cannot self-clear. Separating the "do the work" grants from
  the "write the verdict" grants makes gate bypass a permission error, not
  a matter of trust.
- The clearance logic exists once, in SQL. UI, route, and any future
  client read the same predicate instead of reimplementing it.
- The `SECURITY DEFINER` RPC must pin its `search_path` and be owned by a
  trusted role; it becomes a single-source-of-truth artifact under review
  ownership (see ADR-0003 and CODEOWNERS).
- An adjudicator role and an audited override path must exist before hard
  gates can ship. Overrides require a justification note and are
  void-on-content-change (editing copy re-arms a creative's compliance
  unit).
