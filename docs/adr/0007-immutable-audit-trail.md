# 0007. Immutable (append-only) audit trail at the DB layer

- Status: Proposed
- Date: 2026-05-24
- Deciders: @pveloso01

## Context

The whole stack writes Supabase with ONE credential: the `service_role` key
(`SUPABASE_SECRET_KEY`), used by both the Next.js server and the FastAPI worker.
That role has `rolbypassrls = true`, so the RLS deny-all lockdown (migration
0011) does not constrain it. Until now this meant the audit and evidence tables
were mutable by the exact same key the agent uses for everything else, so "the
audit trail is mutable by the same key the agent uses" was literally true. The
agent (or anything holding the key) could silently rewrite or erase its own
compliance, QA, pipeline, and approval-mode history. For a system whose whole
value proposition is a defensible record of WHY a creative passed or failed
policy, a tamperable record is close to no record.

A subset of these tables is genuinely append-only by design and by code: the
application only ever INSERTs and SELECTs them, never UPDATE or DELETE. Those
are the tables we can harden without changing any application behaviour.

Key mechanism that makes a grant-layer fix real: `rolbypassrls` bypasses
row-level security policies ONLY. It does NOT bypass table-level GRANT
privileges. `service_role` is `nologin bypassrls` (see `db/ci-bootstrap.sql`):
it is not a superuser and does not own these tables. So revoking UPDATE and
DELETE from `service_role` is actually enforced by Postgres, while INSERT
(the append) and SELECT (read-back) keep working.

## Decision

We will make the genuinely append-only audit / evidence tables tamper-evident
at the database layer by revoking UPDATE and DELETE from the writer role, while
keeping INSERT and SELECT. Migration `0041_audit_append_only_immutability.sql`
does this for the proven-append-only set only:

- `events` (domain audit log)
- `pipeline_events` (per-pipeline timeline / task lifecycle)
- `approval_mode_audit` (approval-mode transition log)
- `qa_result` (QA evidence, one immutable row per attempt)

For each, the migration `grant insert, select ... to service_role` (idempotent;
a no-op on hosted Supabase where the role already holds them, and the thing that
keeps appends working in CI where the role starts grant-less) and then
`revoke update, delete ...` from `service_role`, `anon`, and `authenticated`. A
per-table comment records WHY the table is append-only.

We will EXCLUDE every table that is mutated in code, because a false revoke that
breaks the worker is far worse than leaving one table mutable:

- `spec_check` is UPSERTED for idempotent resume (worker
  `operator_stage_tools.py` UPDATEs an existing `(creative_id, platform,
  placement)` row).
- `sync_log` is designed for an update-after-insert run lifecycle (insert
  `status='running'`, later UPDATE `finished_at` / `status`); no code writes it
  yet, but the planned cron heartbeat will UPDATE it, so it stays mutable.
- `compliance_finding` is UPDATED by the compliance override path (sets
  `overridden=true` plus audit columns).
- `creative_stage_state` is UPDATED on every gate transition.

The append-only determination was grounded by a full grep of the worker
(`worker/src`), web (`app/`, `lib/`), and `ekko-skills` code paths for any
UPDATE or DELETE against each candidate table. This decision establishes the
DB grant set as the single source of truth for which audit tables are immutable.

## Consequences

What becomes easier:

- The audit trail for the four hardened tables can no longer be rewritten or
  erased with the service_role key. Tampering now requires a strictly more
  privileged actor (a superuser / direct psql), which narrows the trust surface
  to credentials no application component holds.
- The immutability contract is self-describing: it lives in the grant set and
  in per-table comments visible from `psql \dp`, not only in prose.

New obligations / trade-offs:

- Any future feature that needs to UPDATE or DELETE one of these four tables
  must consciously re-grant (and should reconsider whether the table is still
  append-only). The integration tier
  (`worker/tests/integration/test_pg_audit_immutability.py`) will fail loudly if
  the grant set drifts, so this is caught in CI, not in production.
- This is a grant-layer control: it blocks the application key, not a superuser
  or a direct database operator. It is tamper-RESISTANT for the agent, not
  tamper-PROOF against the platform owner.

Deferred follow-on work (NOT in this decision / migration):

- Hash-chaining: chain each appended row to the prior row's hash so a privileged
  DELETE (superuser / direct psql) becomes detectable after the fact, not just
  blocked at the grant layer.
- WORM export: periodic write-once-read-many export of these tables to immutable
  object storage (e.g. S3 Object Lock) for off-box tamper-evidence and
  retention, independent of the live Supabase project (complements ADR-0006).
