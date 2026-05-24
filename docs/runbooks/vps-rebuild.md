# Runbook: rebuild the VPS from scratch

How to bring the VoxHorizon stack back up on a fresh Hostinger VPS after the
box is lost, replaced, or rebuilt. This recovers the COMPUTE tier (Caddy + web
+ worker). The DATA tier (Supabase Postgres + Storage) is a separate concern;
if the database is also lost, do
[`docs/runbooks/restore.md`](./restore.md) first (or in parallel) and point
this rebuild at the recovered project.

Companion docs: [`infra/deploy/README.md`](../../infra/deploy/README.md) (the
canonical deploy contract), [`SECRETS.md`](../../SECRETS.md) (every runtime
secret), [`docker-compose.yml`](../../docker-compose.yml) (service topology),
[`docs/adr/0006-backups-and-dr.md`](../adr/0006-backups-and-dr.md).

## What the VPS holds vs. what it does not

The VPS is intentionally close to disposable. It runs containers; it is not a
source of truth.

- NOT on the VPS (safe if the box dies): all client data and pipeline state
  (Supabase Postgres), rendered assets (Supabase Storage), and the container
  images (GHCR). Losing the VPS does not lose any of these.
- ON the VPS (must be re-supplied on rebuild): the runtime secrets file
  `/opt/voxhorizon/.env`, the Caddy ACME state (certs, re-issued automatically),
  the deploy user + its authorized deploy key, and the curated b-roll pool named
  volume (`voxhorizon-worker-broll-pool`). The b-roll pool is the one piece of
  operator-curated state that is not reproducible from git or Supabase; if it
  matters, it should be mirrored off-box too (tracked as a follow-up).

## Prerequisites before you start

- A fresh Ubuntu 24.04 LTS VPS with root SSH access.
- The runtime secrets to rebuild `/opt/voxhorizon/.env` (from the dev-box vault,
  see `SECRETS.md` -> VPS production secrets). If Supabase was also rebuilt, use
  the NEW project's URL and keys.
- The GitHub Actions deploy keypair (or regenerate one and update the
  `VPS_SSH_KEY` repo secret).
- DNS control for the dashboard hostname.

## Rebuild steps

1. Provision the box. Bootstrap a freshly imaged Ubuntu 24.04 LTS VPS:

   ```bash
   ssh root@<new-vps-host>
   curl -fsSL https://raw.githubusercontent.com/pveloso01/Diogo-Silva-VoxHorizon-Marketing-Control-Panel/main/infra/deploy/bootstrap-vps.sh \
     -o /root/bootstrap-vps.sh
   less /root/bootstrap-vps.sh        # read before running
   bash /root/bootstrap-vps.sh
   ```

   This installs Docker, configures UFW, and prepares `/opt/voxhorizon`. See
   `infra/deploy/README.md` for flags (`--dry-run`, `--skip-firewall`,
   `--repo-url`).

2. Create the deploy user (if bootstrap did not already):

   ```bash
   sudo bash /opt/voxhorizon/repo/infra/deploy/setup-deploy-user.sh
   ```

   Then append the GitHub Actions deploy public key to
   `~deploy/.ssh/authorized_keys` with the locked-down line format from
   `SECRETS.md` -> GitHub Actions deploy secrets.

3. Place the source. Clone the repo into `/opt/voxhorizon/repo` as the deploy
   user (the deploy workflow does `git reset --hard origin/main` against this
   path):

   ```bash
   sudo -u deploy git clone \
     https://github.com/pveloso01/Diogo-Silva-VoxHorizon-Marketing-Control-Panel.git \
     /opt/voxhorizon/repo
   ```

4. Restore the runtime secrets file. Recreate `/opt/voxhorizon/.env`
   (chmod 600, owned by `deploy:deploy`) from the vault. Required keys are
   inventoried in `SECRETS.md` -> VPS production secrets. Critical ones:
   `SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
   `SUPABASE_SECRET_KEY`, `WORKER_SHARED_SECRET`, `CADDY_BASIC_AUTH_USER`,
   `CADDY_BASIC_AUTH_HASH` (remember the `$$` escaping note in `SECRETS.md`),
   and the integration keys.

   - If Supabase was rebuilt: use the NEW project's URL and keys here. Because
     `NEXT_PUBLIC_*` is also baked into the web image at build time, a project
     change requires a CI rebuild, not just a new `.env` (next step covers it).

5. Verify the deploy SSH path from a workstation:

   ```bash
   ssh -i ~/.ssh/voxhorizon_deploy deploy@<new-vps-host> 'docker compose version'
   ```

6. Point DNS at the new box. Update the dashboard hostname's A/AAAA record to
   the new VPS IP. Caddy will obtain Let's Encrypt certs automatically on first
   start once DNS resolves.

7. Confirm the GitHub Actions deploy secrets match the new box: `VPS_HOST`,
   `VPS_USER` (`deploy`), `VPS_SSH_KEY`. If you regenerated the keypair, update
   `VPS_SSH_KEY`.

8. Deploy. Trigger the stack rollout. Note `deploy-stack.yml` is
   `workflow_dispatch`-only during the rebuild freeze:

   - GitHub -> Actions -> deploy-stack -> Run workflow.
   - If `NEXT_PUBLIC_*` changed (new Supabase project), run `build-web.yml`
     first so the new image is built with the new inlined values, then
     `deploy-stack.yml`.

   The deploy workflow pulls the GHCR images, rolls the compose stack, and waits
   for both `web` and `worker` healthchecks to go green before pruning.

9. Smoke test:

   ```bash
   ssh deploy@<new-vps-host>
   cd /opt/voxhorizon
   docker compose ps                  # web + worker healthy, caddy up
   bash repo/infra/deploy/smoke.sh    # if present
   curl -fsS https://dashboard.voxhorizon.com/api/health   # expect 200
   ```

   Then trigger one end-to-end creative generation to confirm the worker,
   Supabase, and Storage paths are all wired.

10. Restore the b-roll pool (if it was mirrored off-box). The curated b-roll
    lives in the named volume `voxhorizon-worker-broll-pool`. If you have an
    off-box copy, restore it into the volume; otherwise the operator re-curates
    over time.

11. Re-attach external monitoring. Confirm the Uptime Robot / Healthchecks.io
    monitors point at the new host (see `infra/monitoring/README.md`).

## Post-rebuild verification

- [ ] `docker compose ps` shows `web` and `worker` healthy and `caddy` up.
- [ ] `https://dashboard.voxhorizon.com/api/health` returns 200.
- [ ] The dashboard loads behind the Caddy Basic Auth gate.
- [ ] One end-to-end creative generation succeeds (DB + Storage + worker).
- [ ] The next scheduled `backup.yml` run succeeds against the current
      `SUPABASE_DB_URL`.
- [ ] External monitors are green and pointed at the new host.

## Known follow-ups

- Off-box mirror of the curated b-roll pool named volume (the one non-git,
  non-Supabase piece of state on the box).
- Tighten the deploy key with a `from=` CIDR restriction and optional
  `command=` forced command once the new box is proven (see `SECRETS.md`).
