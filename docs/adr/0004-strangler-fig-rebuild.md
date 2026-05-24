# 0004. Foundation-first strangler-fig rebuild strategy

- Status: Accepted
- Date: 2026-05-24
- Deciders: @pveloso01

## Context

The pipeline needs to grow from a 5-stage renderer into a 12-stage ad
producer with QA and compliance as first-class, hard-gated concerns. A
full rewrite on a new stack was considered and rejected: the existing
stack and several primitives are genuinely strong and worth keeping.

- The proven parts to reuse: Next.js (App Router) plus Supabase
  (Postgres, RLS, Realtime, Storage) plus the FastAPI worker plus the
  Hermes operator; the approvals long-poll; the SSE realtime relay; the
  idempotent render contract; the append-only event log backbone.
- There are live pipelines in the database. Even though they are mostly
  inert, a rewrite that drops or reshapes their tables out from under them
  is a regression we will not accept.
- The product is single-operator today, but a future tenant boundary is
  foreseeable and should not require re-founding the data model again.

## Decision

We will refactor in place using the strangler-fig pattern rather than
rewriting.

- Keep the stack and reuse the strong primitives listed above; re-found
  only the data model, orchestration, agent layer, UX, and integrations
  that need it.
- Migrate live data with expand/migrate/contract: add the new shape
  alongside the old, backfill and dual-write or repoint readers, then
  contract by removing the old shape once nothing reads it. Migrations are
  forward-only and validate on a Supabase branch before they touch the
  live project. Live pipelines never regress.
- Build single-operator now, but reserve the tenant seam: design tables
  and keys so a tenant scope can be introduced later without another
  ground-up migration. Do not build multi-tenant machinery yet.

## Consequences

- The system stays shippable throughout the rebuild; each migration and
  each stage lands behind its own gate instead of in one risky cutover.
- Expand/migrate/contract means some duplication exists transiently (old
  and new shapes coexist) and the contract step must actually be done, not
  deferred indefinitely.
- Reserving the tenant seam adds a little up-front design thought but
  avoids a second re-founding. We explicitly do not pay for unused
  multi-tenant features now.
- Reused primitives constrain new design to remain compatible with the
  approvals long-poll, the SSE relay, and the idempotent render contract;
  this is an accepted constraint, since replacing them is out of scope.
- This strategy is the umbrella under which ADR-0001 (creative identity),
  ADR-0002 (gates), and ADR-0005 (reliability primitives) are delivered.
