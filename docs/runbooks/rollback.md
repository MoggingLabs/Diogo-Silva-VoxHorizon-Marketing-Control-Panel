# Runbook: rolling code back safely

Status: E5.5 / #523. Owner: whoever is on deploy duty.

This runbook covers rolling the **code** (worker + web images) back to a
previous version. It exists because schema and code are deployed on **separate
tracks**:

- **Code** ships via `deploy-stack.yml`: build images, push to GHCR (tagged
  `latest` AND the commit SHA), SSH to the VPS, `docker compose pull && up -d`.
- **Schema** is pushed **manually** via `supabase db push` (forward-only file
  migrations in `db/migrations`, `0001..N`, no `schema_migrations` table). It is
  NOT applied by the deploy.

A rollback rolls **code only**. There is no automated "roll the schema back",
and you almost never want one (see [Why we do not roll migrations
back](#why-we-do-not-roll-migrations-back)). The safety property that makes a
code-only rollback safe is a rule every migration author must uphold:

> **The backward-compatibility contract.** Every migration MUST be backward
> compatible with the **previously deployed** code image. The schema is allowed
> to be AHEAD of the running code, but the running code must keep working against
> it. If that holds, you can always roll the code back to the previous image
> without touching the DB.

This is the expand/contract discipline. See [docs/migrations.md](../migrations.md)
for how to write a migration that honours it.

---

## Pre-flight: what state are you in?

The two deployed tracks give four combinations. Find your row before acting.

| Code (running image) | Schema (live DB) | Situation | Action |
| --- | --- | --- | --- |
| new | new | healthy | nothing to do |
| new | OLD (push forgotten) | code expects columns the DB lacks; the pre-deploy gate or the in-app `schema_guard` should have caught this | run the owed `supabase db push` (fix forward), do NOT roll back |
| OLD | new | the normal rollback target: code rolled back, schema left ahead | safe IF the new migration was expand-only (the contract). Roll code back. |
| OLD | OLD | clean previous state | safe rollback, nothing special |

The case the backward-compatibility contract protects is **OLD code + new
schema**: after you roll the code back, the previous image runs against the newer
schema. That only works if the migration was additive.

---

## A. Roll the code back (worker + web)

Images are tagged with the commit SHA, so rollback is pinning to the previous
SHA. Two paths:

### A1. Re-deploy the previous commit (preferred)

The deploy resets the VPS repo to `origin/main` and pulls `:latest`, so the
clean rollback is to make the previous good commit the head of main again:

1. Identify the last-good commit SHA (the deploy you want to return to). Check
   the Actions run history for `deploy-stack` or `git log` on the VPS:
   `git -C /opt/voxhorizon/repo log --oneline -5`.
2. Revert the bad change on `main` (`git revert <bad-sha>` via a PR, or
   fast-revert if you have the access), so `origin/main` points at good code
   again.
3. Run `deploy-stack` (Actions -> Run workflow -> `workflow_dispatch`). It
   rebuilds `:latest` from the reverted main and rolls the stack. The pre-deploy
   migration gate runs as usual and will block if the schema floor is not met.

### A2. Hot-pin images to the previous SHA (fastest, no rebuild)

When you need the previous image NOW and cannot wait for a rebuild, pin compose
to the previous SHA on the VPS:

```bash
ssh <deploy-user>@<vps-host>
cd /opt/voxhorizon
# Pull the previous good images by SHA (replace <prev-sha>).
docker pull ghcr.io/<owner>/voxhorizon-worker:<prev-sha>
docker pull ghcr.io/<owner>/voxhorizon-web:<prev-sha>
# Retag them locally as :latest so compose (which references :latest) uses them.
docker tag ghcr.io/<owner>/voxhorizon-worker:<prev-sha> ghcr.io/<owner>/voxhorizon-worker:latest
docker tag ghcr.io/<owner>/voxhorizon-web:<prev-sha>    ghcr.io/<owner>/voxhorizon-web:latest
docker compose up -d --remove-orphans
```

This is a stop-gap. The NEXT `deploy-stack` run will reset the VPS repo to
`origin/main` and rebuild `:latest`, so you MUST still land the revert on `main`
(A1) or the bad code comes back on the next deploy. Note A2 bypasses the
pre-deploy migration gate, so confirm the schema is compatible by hand first
(see B).

### A3. Verify health after rollback

The deploy job waits for both `web` and `worker` healthchecks before pruning. If
you rolled by hand (A2), check the same:

```bash
docker compose ps
for svc in web worker; do
  cid=$(docker compose ps -q "$svc")
  docker inspect --format='{{.State.Health.Status}}' "$cid"
done
docker compose logs --tail=100 worker
```

On worker boot, look for the `schema_guard` log line:

- `schema_guard_ok` -> the running code's schema floor is satisfied.
- `schema_guard_behind` -> the code expects a migration the DB lacks. STOP and
  go to B; the rollback target is older than the DB only matters the other way,
  but a `behind` after a rollback means you rolled FORWARD by mistake or the DB
  is older than even the previous code expected.
- `schema_guard_skipped` -> Supabase was unreachable from the worker; the guard
  could not verify. Investigate connectivity.

---

## B. Confirm the schema is compatible with the rolled-back code

The rolled-back (older) code requires an OLDER schema floor than current. Because
migrations are forward-only and additive, an older code image runs fine against a
newer schema. The thing that breaks an older image is a migration that was NOT
backward compatible (a column it reads was dropped/renamed, a type changed under
it, a `NOT NULL` was added it does not populate). If such a migration shipped,
the contract was violated and a code-only rollback is NOT safe on its own.

To check what the rolled-back code requires, read its `schema_guard`
`REQUIRED_MIGRATION` (in `worker/src/services/schema_guard.py` at that commit).
As long as that migration is present in the live DB, the floor is met. Since the
live DB only ever moves forward, it always is.

---

## Why we do not roll migrations back

`db/migrations` is **forward-only**: there are no `down` scripts, and there is no
`schema_migrations` ledger to "un-apply" against. On a live multi-tenant DB a
schema rollback (drop the new column/table) is a destructive, data-losing
operation that races every tenant's in-flight traffic. So the discipline is:

- **Never** drop/rename/retype in the same step that adds (expand/contract,
  [docs/migrations.md](../migrations.md)).
- **Roll code back, not schema.** The backward-compatibility contract guarantees
  the previous image runs against the current (ahead) schema.
- If a migration truly must be undone, do it as a NEW forward migration in a
  later, separate deploy (the contract step), never as a rollback.

---

## C. If the schema got ahead by mistake (forgotten or wrong `db push`)

This is the OLD code + new schema corner where the new schema is NOT compatible,
or the new code + OLD schema corner (the gate should have blocked the deploy):

- **New code, old schema** (gate blocked the deploy, or `schema_guard_behind` in
  logs): fix FORWARD. Run the owed `supabase db push` against the correct
  project, confirm `schema_guard_ok`, then re-run the deploy. Do not roll the
  code back to "match" the old schema; bring the schema up.
- **`db push` ran against the wrong project**: there is no automated undo. Treat
  it as an incident, snapshot first, and reconcile by hand. Prevention is the
  pre-deploy gate (it probes the DSN the deploy will use) plus double-checking
  `supabase link --project-ref` before any push.
