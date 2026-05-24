# 0006. Backups and disaster recovery (RPO/RTO)

- Status: Proposed
- Date: 2026-05-24
- Deciders: @pveloso01

## Context

Supabase managed Postgres is the single source of truth for every client
(ADR-0003), and Supabase Storage buckets hold the rendered creative assets.
Today the system has no owned backup, no restore procedure, and no rebuild
runbook. The only safety net is whatever the Supabase plan provides, which
lives in the same vendor account as the live data. That is a single point of
failure with no defined recovery objective:

- If the Supabase project is deleted, suspended for billing, or corrupted by a
  bad write, there is no independent copy to restore from.
- The VPS is a single Hostinger box. If it is lost, there is no written
  procedure to rebuild the stack, and no test that the data could be restored
  into a fresh project.
- Deploy applies no migrations, so a "restore" is not just data; the schema
  has to be reconstructed from the forward-only migration chain.

We need two things stated as numbers, not vibes: how much data we can afford to
lose (Recovery Point Objective, RPO) and how long recovery may take (Recovery
Time Objective, RTO). And we need both backed by a mechanism that is exercised,
not merely configured, echoing the "designed but never wired" anti-pattern
ADR-0005 exists to stop.

## Decision

We will run a two-tier backup strategy with explicit objectives, and prove the
recovery tier on a schedule.

- Target RPO <= 5 minutes via Supabase Point-in-Time Recovery (PITR). PITR is
  the primary, low-data-loss tier: it lets us roll the live project back to a
  moment just before a corrupting event. This is the first line of defense for
  the common case (a bad migration, a mistaken bulk write) where the Supabase
  project itself is still healthy.

- Target RTO <= 1 hour via an independent, off-vendor pg_dump. A scheduled
  GitHub Actions workflow (`.github/workflows/backup.yml`) runs a daily
  `pg_dump` (custom format, integrity-checked) and ships it to an
  S3-compatible object store we control, outside the Supabase account. This is
  the floor of the recovery story: if the entire Supabase project is gone, we
  restore the latest off-box dump into a fresh project and reapply migrations,
  with a written target of being back inside an hour. The off-box tier bounds
  the worst-case RPO at <= 24 hours (one day between dumps); the <= 5 minute RPO
  applies only while PITR is usable.

- The recovery path is scripted and rehearsed, not just documented.
  `scripts/backup-db.sh` and `scripts/restore-db.sh` are the runnable
  mechanism; `docs/runbooks/restore.md` is the procedure; and a quarterly
  restore drill (restore the latest dump into a throwaway scratch database)
  is the proof. A backup we have never restored is not a backup.

- Supabase Storage buckets are backed up as a documented step, not yet
  automated in CI. The database dump does not include Storage objects; mirroring
  them off-box needs a separate Storage S3 credential. Until the operator
  decides where Storage backups live, the mirror command is recorded in the
  restore runbook as a manual step, and automating it is tracked as follow-on
  work.

The destination, credentials, and PITR enablement are operator-wired. The
workflow references secret NAMES only and is a deliberate no-op until the
secrets exist, so this decision can land before the infrastructure is in place
without showing a false-green or false-red signal.

## Consequences

- We gain a stated, defensible recovery posture: <= 5 min RPO for the common
  in-project case, <= 1 h RTO for total project loss, and a hard ceiling of
  <= 24 h data loss in the catastrophic case. These numbers become testable
  claims rather than hopes.

- New standing obligations. PITR must be enabled on a Supabase plan that offers
  it (a paid tier), the off-box bucket and its credentials must exist, and the
  quarterly restore drill must actually be run and recorded. An unrun drill
  silently erodes the guarantee.

- The recovery tier is independent of the vendor by design. A Supabase account
  compromise or suspension does not also take the backups, because they live in
  a different provider under our control.

- Cost is accepted: a paid Supabase tier for PITR, object-store storage for the
  retained dumps, and a small amount of operator time each quarter for the
  drill. For a single source of truth holding every client's data this is the
  deliberate price of not being one bad write away from unrecoverable loss.

- Follow-on work this implies: enable PITR on the project; create the off-box
  bucket and add the backup secrets; schedule the first quarterly restore drill;
  and decide on and automate the Supabase Storage off-box mirror (today a manual
  step in the runbook).
