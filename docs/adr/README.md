# Architecture Decision Records (ADRs)

This directory holds the architecturally significant decisions for the
VoxHorizon Marketing Control Panel rebuild. An ADR captures one decision:
the context that forced it, what we chose, and the consequences we accept.
ADRs are short (about one page), immutable once accepted, and numbered in
the order they are made.

We use the MADR format (Markdown Any Decision Records). Each record has
four parts: Context, Decision, Status, Consequences. The blank starting
point is [`0000-template.md`](./0000-template.md).

## Why we keep ADRs

The rebuild re-founds the pipeline data model, the gate enforcement, and
the reliability primitives. Those choices are easy to erode by accident
over many small PRs. An ADR is the durable record of why a constraint
exists, so a future change either conforms to it or supersedes it on
purpose, in the open, with a paper trail.

## The flow

1. Copy `0000-template.md` to the next free number, e.g.
   `0006-some-decision.md`. Numbers are never reused.
2. Fill in Context, Decision, Consequences. Set Status to `Proposed` and
   add the date.
3. Open a PR. The decision is discussed on the PR, not in the file.
4. On merge, set Status to `Accepted`.
5. To reverse or replace a decision, do not edit the accepted record in
   place. Write a new ADR that supersedes it, and set the old record's
   Status to `Superseded by ADR-XXXX`.

## Status values

- `Proposed`: under discussion, not yet binding.
- `Accepted`: in force; conforming changes are expected to honour it.
- `Superseded by ADR-XXXX`: replaced by a later decision.
- `Deprecated`: no longer relevant and not replaced.

## Index

| ADR                                                | Title                                                 | Status   |
| -------------------------------------------------- | ----------------------------------------------------- | -------- |
| [0001](./0001-neutral-creative-identity.md)        | Neutral creative identity (class-table inheritance)   | Accepted |
| [0002](./0002-db-enforced-gates-adjudicator.md)    | DB-enforced gates plus an adjudicator role            | Accepted |
| [0003](./0003-single-source-of-truth.md)           | Single source of truth per invariant                  | Accepted |
| [0004](./0004-strangler-fig-rebuild.md)            | Foundation-first strangler-fig rebuild strategy       | Accepted |
| [0005](./0005-reliability-primitives-on-path.md)   | Reliability primitives wired onto the primary path    | Accepted |
| [0006](./0006-backups-and-dr.md)                   | Backups and disaster recovery (RPO/RTO)               | Proposed |

## Related documents

- [`PIPELINE-REBUILD-ARCHITECTURE.md`](../../PIPELINE-REBUILD-ARCHITECTURE.md): the canonical 6-layer rebuild design these ADRs back-fill.
- [`ARCHITECTURE.md`](../../ARCHITECTURE.md): the broader system spec.
- [`db/SCHEMA.md`](../../db/SCHEMA.md): pointer to the migration-defined schema.
