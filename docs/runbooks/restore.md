# Runbook: database restore and disaster recovery

How to recover the VoxHorizon database when something has gone wrong, and how
to prove the backups work before you ever need them. Pairs with
[`docs/adr/0006-backups-and-dr.md`](../adr/0006-backups-and-dr.md) (the RPO/RTO
decision), the scheduled
[`backup.yml`](../../.github/workflows/backup.yml) workflow, and the
[`scripts/backup-db.sh`](../../scripts/backup-db.sh) /
[`scripts/restore-db.sh`](../../scripts/restore-db.sh) helpers.

Companion runbook for rebuilding the box itself:
[`docs/runbooks/vps-rebuild.md`](./vps-rebuild.md).

## Recovery objectives at a glance

| Objective | Target | Mechanism |
| --------- | ------ | --------- |
| RPO (in-project corruption) | <= 5 minutes | Supabase Point-in-Time Recovery (PITR) |
| RPO (total project loss) | <= 24 hours | Daily off-box `pg_dump` |
| RTO (total project loss) | <= 1 hour | Restore latest off-box dump into a fresh project + reapply migrations |

The database is the single source of truth for every client (ADR-0003), so
treat every step here as a careful, deliberate operation. When in doubt, stop
and restore into a scratch database first to confirm the dump is good.

## Pick the right recovery path

Diagnose first, then choose the smallest hammer:

1. Bad write / bad migration, Supabase project still healthy
   -> Use Supabase PITR (Scenario A). Lowest data loss, fastest, no off-box dump
   needed.

2. Need yesterday's data into a scratch DB for inspection, or PITR window does
   not reach far enough back
   -> Restore an off-box dump into a scratch database (Scenario B).

3. Supabase project is gone, suspended, or unrecoverable
   -> Full disaster recovery: restore the latest off-box dump into a fresh
   project and reapply migrations (Scenario C).

---

## Scenario A: Point-in-Time Recovery (PITR)

Use when the Supabase project is healthy but the data was corrupted (e.g. a
mistaken bulk update or a bad migration) and you want to roll back to just
before it. This is the <= 5 minute RPO tier.

1. Stop the writers so nothing new lands while you recover. On the VPS:

   ```bash
   ssh deploy@<vps-host>
   cd /opt/voxhorizon
   docker compose stop worker web
   ```

2. In the Supabase dashboard, go to Database -> Backups -> Point in Time and
   pick the timestamp just before the corrupting event. Confirm the restore.

   - PITR requires a paid Supabase plan. If Point in Time is not available,
     PITR is not enabled. Fall back to Scenario B/C using the off-box dump, and
     enable PITR afterwards (see the wiring checklist below).

3. Wait for Supabase to report the restore complete. The connection string and
   keys are unchanged, so no app config changes are needed.

4. Bring the stack back up and smoke test:

   ```bash
   docker compose start worker web
   curl -fsS https://dashboard.voxhorizon.com/api/health   # expect 200
   ```

5. Record what happened (timestamp restored to, cause) in the incident notes.

---

## Scenario B: restore an off-box dump into a scratch database

Use to inspect a past state, or as the verification half of Scenario C, or as
the quarterly drill. This NEVER touches production.

Prerequisites on the machine you run from:

- `pg_dump` / `pg_restore` (Postgres client matching the server major version).
- `aws` CLI.
- The backup-store credentials and a scratch Postgres to restore into.

Steps:

1. Export the backup-store environment (names match the workflow and scripts):

   ```bash
   export BACKUP_S3_BUCKET=<bucket-name>
   export BACKUP_S3_ENDPOINT=<endpoint-url-if-not-aws>   # optional
   export BACKUP_S3_REGION=<region>                      # optional, default us-east-1
   export AWS_ACCESS_KEY_ID=<access-key>
   export AWS_SECRET_ACCESS_KEY=<secret-key>
   ```

2. List what is available and confirm a recent dump exists:

   ```bash
   bash scripts/restore-db.sh --list
   ```

3. Dry run against the latest dump (downloads + integrity-checks, writes
   nothing):

   ```bash
   bash scripts/restore-db.sh --dry-run
   ```

4. Point at a SCRATCH database and restore. Triple-check this DSN is not
   production:

   ```bash
   export TARGET_DB_URL='postgresql://postgres:<pw>@<scratch-host>:5432/postgres'
   bash scripts/restore-db.sh --confirm
   ```

   The script prints the target host (password masked) and refuses to proceed
   without `--confirm`.

5. Spot-check the restored data (row counts on the busiest tables, newest
   `created_at`, the migration history table). Then drop the scratch database.

---

## Scenario C: full disaster recovery (project loss)

Use when the Supabase project is gone or unusable. This is the <= 1 hour RTO
path. Work top to bottom; do not skip the verification step.

1. Create a new Supabase project (same region, `us-east-1`, to stay close to the
   VPS). Note the new project ref, direct connection string (port 5432), and
   the new API keys.

2. Reapply the schema from the forward-only migration chain. Deploy applies no
   migrations, so the schema is reconstructed from `db/migrations/**` (or the
   Supabase CLI against the new project). Do this BEFORE restoring data so the
   restore lands into the correct schema shape. Do NOT run `supabase db push`
   against the OLD project; you are building the NEW one.

3. Restore the latest off-box dump into the new project's direct connection:

   ```bash
   export BACKUP_S3_BUCKET=<bucket-name>
   export AWS_ACCESS_KEY_ID=<access-key>
   export AWS_SECRET_ACCESS_KEY=<secret-key>
   export TARGET_DB_URL='postgresql://postgres:<new-pw>@db.<new-ref>.supabase.co:5432/postgres'
   bash scripts/restore-db.sh --confirm
   ```

   The dump was taken `--no-owner --no-privileges`, and restore runs
   `--clean --if-exists --no-owner --no-acl`, so it lands cleanly into the
   migration-defined schema and grants.

4. Restore the Supabase Storage buckets (see the Storage section below).

5. Repoint the application at the new project. Update the relevant secrets and
   roll the stack:

   - GitHub Actions repo secrets used at build time:
     `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`.
   - VPS runtime `/opt/voxhorizon/.env`: `SUPABASE_URL` /
     `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
     `SUPABASE_SECRET_KEY`.
   - Because `NEXT_PUBLIC_*` values are inlined at build time, a project change
     needs a CI rebuild + redeploy, not just a container restart (see
     `SECRETS.md`). Trigger `build-web.yml`, then `deploy-stack.yml`.

6. Verify end to end:

   ```bash
   curl -fsS https://dashboard.voxhorizon.com/api/health   # expect 200
   ```

   Then trigger one end-to-end creative generation to confirm the DB, Storage,
   and worker paths are all wired against the new project.

7. Re-enable PITR on the new paid project and confirm the next scheduled
   `backup.yml` run succeeds against the new `SUPABASE_DB_URL`.

---

## Supabase Storage buckets

`pg_dump` does NOT include Storage objects (e.g. the private `creatives`
bucket). They are backed up and restored separately.

Off-box mirror (manual today; automation is a tracked follow-up in ADR-0006).
This needs Supabase Storage S3 credentials, which are a SEPARATE credential pair
from the database password (Supabase dashboard -> Storage -> S3 connection):

```bash
# Mirror Supabase Storage off-box (run periodically, or before a risky change):
aws s3 sync \
  s3://<supabase-storage-bucket> \
  s3://<backup-bucket>/storage/ \
  --endpoint-url <supabase-storage-s3-endpoint>
```

Restore Storage into the new project after Scenario C step 4, reversing the
sync into the new project's Storage S3 endpoint:

```bash
aws s3 sync \
  s3://<backup-bucket>/storage/ \
  s3://<new-supabase-storage-bucket> \
  --endpoint-url <new-supabase-storage-s3-endpoint>
```

The database stores Storage object paths, so once the bucket contents are back
under the same keys, the signed-URL paths the app mints resolve again.

---

## Quarterly restore drill checklist

A backup that has never been restored is not a backup. Run this once a quarter
and record the result. It uses only a scratch database and never touches
production. Target: complete in under an hour to validate the RTO claim.

- [ ] Date of drill: ____________  Operator: ____________
- [ ] `scripts/restore-db.sh --list` shows a dump from within the last 24h.
- [ ] `scripts/restore-db.sh --dry-run` downloads and integrity-checks the
      latest dump with no errors.
- [ ] Provision a scratch Postgres (local Docker, a temporary Supabase project,
      or a throwaway DB) and apply the migration chain to it.
- [ ] `TARGET_DB_URL=<scratch> scripts/restore-db.sh --confirm` completes.
- [ ] Spot-check restored data: row counts on the top tables look sane; newest
      `created_at` matches expectations; migration history table is present.
- [ ] Measure wall-clock time from "decide to restore" to "data verified".
      Record it; confirm it is within the <= 1h RTO target (or file a follow-up
      if not).
- [ ] Confirm Supabase PITR is still enabled (Database -> Backups -> Point in
      Time is available).
- [ ] Drop the scratch database / delete the temporary project.
- [ ] Record outcome (pass/fail, time taken, anything surprising) and link it
      from the next drill.

If any box fails, fix the cause before the quarter ends. A failed drill means
the recovery guarantee is currently fictional.

---

## Operator wiring checklist (one-time)

These steps are NOT done by this PR. Until they are, `backup.yml` is a
deliberate no-op and there are no off-box dumps to restore.

- [ ] Create the off-box object-store bucket (S3 / Backblaze B2 / R2 / MinIO),
      private, in a provider separate from Supabase. Add a lifecycle / retention
      policy.
- [ ] Create a scoped access key for that bucket (write-only or write+list is
      enough for the backup job).
- [ ] Add the repo secrets (Settings -> Secrets and variables -> Actions):
      `SUPABASE_DB_URL` (direct connection, port 5432), `BACKUP_S3_BUCKET`,
      `BACKUP_S3_ACCESS_KEY_ID`, `BACKUP_S3_SECRET_ACCESS_KEY`, and if not AWS
      `BACKUP_S3_ENDPOINT` + `BACKUP_S3_REGION`.
- [ ] Optionally add repo variables: `BACKUP_RETENTION_DAYS`,
      `SUPABASE_PG_MAJOR` (defaults to 16).
- [ ] Run `backup.yml` via `workflow_dispatch` once and confirm a dump lands in
      the bucket.
- [ ] Enable Supabase PITR (paid plan) to meet the <= 5 min RPO target.
- [ ] Decide where Storage backups live and either run the manual mirror on a
      cadence or automate it (ADR-0006 follow-up).
- [ ] Schedule the first quarterly restore drill.
