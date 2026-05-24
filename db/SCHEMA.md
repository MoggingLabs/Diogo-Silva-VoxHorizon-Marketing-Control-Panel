# Database schema reference

This file is no longer hand-maintained.

The Postgres schema for the VoxHorizon Marketing Control Panel is defined
by the forward-only migrations in [`db/migrations`](./migrations). Those
files are the single source of truth for tables, enums, RLS, triggers, and
helper functions (see ADR-0003, "Single source of truth per invariant").

This document previously carried a hand-written, table-by-table
description, but it fell behind the live schema (it documented only through
migration `0015`, while the current head is `0032+`). Rather than maintain
a second copy that drifts, read the migrations directly.

## Where to look

- [`db/migrations`](./migrations): the authoritative, forward-only SQL.
  Never edit a merged migration; add a new numbered file.
- The generated TypeScript types in `lib/supabase/types.gen.ts` are the
  derived, code-side view of the schema (regenerated after each
  migration). See ADR-0003 and `.github/CODEOWNERS`.
- [`PIPELINE-REBUILD-ARCHITECTURE.md`](../PIPELINE-REBUILD-ARCHITECTURE.md)
  describes the data-model layer and the migration order for the rebuild.
- [`docs/adr`](../docs/adr): the architecture decision records behind the
  current schema design.

If a schema generator is added later, this reference becomes generated
output; until then, the migrations are canonical and authoritative.
