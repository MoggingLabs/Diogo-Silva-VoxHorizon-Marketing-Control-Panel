# 0001. Neutral creative identity via class-table inheritance

- Status: Accepted
- Date: 2026-05-24
- Deciders: @pveloso01

## Context

The current schema splits every creative concern into two parallel
lineages: `creatives` / `video_creatives`, `copy_variants` /
`video_copy_variants`, `launch_packages` / `video_launch_packages`, and so
on. The two verticals were forked early so each could evolve its column
shapes independently, but the cost has compounded:

- There is no shared creative identity. A gate, an evidence row, or a
  launch record cannot hold a single foreign key to "the creative" it
  describes, because there are two unrelated tables it might point at.
  Shared concerns are forced into polymorphic, FK-less pointers (the
  `(creative_type, creative_id)` pattern already used by `chat_messages`),
  which the database cannot enforce.
- The fork leaks into application code as roughly 82 `is_video` branches
  across the worker and the dashboard. Every new shared feature has to be
  written, tested, and kept in sync twice.

The rebuild introduces first-class, per-creative gate state (creative QA,
compliance, copy, spec) plus append-only evidence and a launch graph. All
of those need to reference one creature: the creative. The two-lineage
model makes that impossible to express with real foreign keys.

## Decision

We will model creatives with class-table inheritance: a single `creative`
base table that carries the shared identity and lifecycle, plus per-format
extension tables (image-specific and video-specific columns) that share
the base table's primary key. Every shared concern (gate state, evidence,
copy variants, spec checks, variant plans, launch handoff, performance)
foreign-keys the base `creative`, not a per-format table.

Format-specific data stays in the format extension tables, so each
vertical can still evolve its own columns without disturbing the other.
The discriminator on the base row drives format-specific behaviour;
shared behaviour reads the base.

## Consequences

- Shared gate, evidence, and launch tables get real, enforced foreign keys
  to a single creative identity. The polymorphic FK-less pattern is no
  longer needed for these relationships.
- The `is_video` branching collapses: shared logic operates on the base
  creative once; only genuinely format-specific steps branch, and they
  branch on the discriminator in one obvious place.
- New shared features are written, migrated, and tested once instead of
  twice.
- Migrating live data requires an expand/migrate/contract sequence (see
  ADR-0004): introduce the base and extensions, backfill from the existing
  tables, repoint references, then retire the duplicated columns. The two
  legacy lineages cannot be dropped until all readers move to the base.
- A small amount of join cost is added (base plus extension) for
  format-specific reads, which is an accepted trade-off for the enforced
  identity and the removed branching.
