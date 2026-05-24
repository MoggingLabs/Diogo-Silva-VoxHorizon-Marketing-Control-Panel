# 0005. Reliability primitives wired onto the primary path

- Status: Accepted
- Date: 2026-05-24
- Deciders: @pveloso01

## Context

The system has reached for durability before, but the primitives were
designed and then left unwired: present in the schema or the code, yet not
on the path that real work actually takes. The result was the worst of
both worlds: the appearance of safety without the guarantee.

The rebuild has side effects that must not double-fire or silently drop:

- The irreversible Meta launch (create campaign, then adset, then ad).
- External generation work whose completion arrives asynchronously (the
  kie generation callback) and which can be lost or delayed.
- Stage work that must survive a worker restart and not be advanced on a
  heuristic.

These need exactly-once side effects, reconciliation for async results,
and a durable record of outstanding work, and they need to be the
mechanism the primary path uses, not an optional add-on next to it.

## Decision

We will wire the reliability primitives directly onto the primary
execution path, so the normal flow cannot bypass them.

- Transactional outbox plus relay: state changes and the intent to perform
  a side effect are written in the same transaction to an outbox; a relay
  drains it with `SELECT ... FOR UPDATE SKIP LOCKED`, and consumers dedupe
  on a deterministic idempotency key. The irreversible Meta launch runs as
  an orchestrated, paused-first saga with per-step idempotency and
  compensation that never stops live spend.
- Callback plus reconciliation: the kie generation callback is the primary
  completion signal, backed by a reconciliation poll that closes out work
  the callback missed. Neither alone is trusted to be complete.
- Durable work queue / ledger: a per-work-unit ledger is the closure
  authority for agent-work stages. Closure means no queued or running
  units and at least one done; an all-error batch does not close as
  success.

The anti-pattern this ADR exists to stop is "designed but never wired".
A reliability primitive is not considered done until the primary path
goes through it and a test proves the failure mode it covers.

## Consequences

- Side effects become exactly-once on the real path. Retries, restarts,
  and duplicate callbacks converge to one outcome instead of double-firing
  or dropping.
- Async completions are no longer trusted blindly; the reconciliation poll
  is a standing obligation that must run on a schedule and be monitored
  (outbox depth, in-flight units, breaker state).
- Advancement is gated on the work ledger, not on event counts, which
  reinforces the no-stall and no-false-advance invariants from ADR-0002.
- Definition of done is stricter: a primitive must be on the path and
  covered by a failure-mode test. This raises the bar per change and is
  the deliberate cost of not repeating the unwired-safety mistake.
- The outbox, inbox, relay, and ledger add operational surface (a relay to
  run, sweeps to schedule, metrics to watch); this is accepted as the
  price of durable side effects on a single-operator stack.
