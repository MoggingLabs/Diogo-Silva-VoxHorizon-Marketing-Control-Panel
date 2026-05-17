# Deploy

The contract between this repo and the VPS that runs the worker. If the workflow ([`.github/workflows/deploy-worker.yml`](../../.github/workflows/deploy-worker.yml)) ever drifts from what's documented here, fix one or the other so they agree.

Companion docs: [`ARCHITECTURE.md`](../../ARCHITECTURE.md#deployment-pipeline), [`SECRETS.md`](../../SECRETS.md#github-actions-deploy-secrets), [`infra/monitoring/README.md`](../monitoring/README.md).

---

## What the workflow does

`deploy-worker.yml` runs on every push to `main` that touches:

- `worker/**` — source, Dockerfile, dependency manifests
- `Caddyfile` — TLS / routing in front of the worker
- `docker-compose.yml` — service topology
- `.github/workflows/deploy-worker.yml` — the workflow itself (self-deploys fixes)

Plus a manual `workflow_dispatch` trigger for bootstrap, hotfix, and validation runs.

Two jobs, sequenced:

1. **`build-and-push`** — checks out the repo, sets up Buildx, logs into GHCR with the run's `GITHUB_TOKEN`, builds `worker/Dockerfile` (context: `worker/`), and pushes two tags:
   - `ghcr.io/pveloso01/voxhorizon-worker:latest`
   - `ghcr.io/pveloso01/voxhorizon-worker:<commit-sha>`

   Build cache is GHA-backed (`cache-from: type=gha`, `cache-to: type=gha,mode=max`) so repeat builds reuse layers.

2. **`deploy`** — SSHes into `${{ secrets.VPS_HOST }}` as `${{ secrets.VPS_USER }}` using `${{ secrets.VPS_SSH_KEY }}` and runs (under `set -euo pipefail`):

   ```bash
   cd /opt/voxhorizon
   echo "$GITHUB_TOKEN" | docker login ghcr.io -u "$GH_ACTOR" --password-stdin
   git fetch --quiet origin main
   git reset --hard origin/main
   docker compose pull
   docker compose up -d --remove-orphans
   # poll worker healthcheck for ~50s
   docker image prune -f
   ```

   The healthcheck loop reads `docker inspect --format='{{.State.Health.Status}}' <worker-container>` ten times with a 5s sleep. If the container hasn't reported `healthy` by the end, the script dumps the worker's last 200 log lines and exits non-zero so the workflow run fails loudly.

Concurrency: `group: deploy-worker`, `cancel-in-progress: false`. Two pushes in quick succession queue; we never kill a rollout mid-flight.

The `WORKER_IMAGE_TAG` env var in `docker-compose.yml` defaults to `latest`, so `docker compose pull` resolves to the freshly-pushed image without any per-deploy templating. Pinning to a specific SHA is the rollback path (next section).

---

## Manual rollback

You're on the VPS, the latest rollout is bad, you need the previous green build back.

1. Find the previous SHA. Either:
   - Look at the GitHub Actions history (last green run before the bad one) and copy the commit SHA.
   - Or check the GHCR tags page: `https://github.com/pveloso01/Diogo-Silva-VoxHorizon-Marketing-Control-Panel/pkgs/container/voxhorizon-worker`.

2. SSH in and pin the worker to that SHA:

   ```bash
   ssh deploy@<vps-host>
   cd /opt/voxhorizon
   # Pull the rollback image explicitly so it's local
   docker pull ghcr.io/pveloso01/voxhorizon-worker:<prev-sha>
   # Roll the worker to the pinned tag
   WORKER_IMAGE_TAG=<prev-sha> docker compose up -d --remove-orphans worker
   # Confirm
   docker compose ps
   docker inspect --format='{{.State.Health.Status}}' "$(docker compose ps -q worker)"
   ```

3. Verify externally:

   ```bash
   curl -fsS https://worker.<your-domain>/work/ping   # → {"ok":true}
   ```

4. **Make the pin sticky until the fix lands.** If you leave `WORKER_IMAGE_TAG` unset, the next workflow run will overwrite the rollback by pulling `latest` again. Two options:
   - **Quick.** Export the var in the deploy user's shell so subsequent ad-hoc `docker compose` calls pin it: `echo 'export WORKER_IMAGE_TAG=<prev-sha>' >> ~/.bashrc`. (The GH Actions workflow does not source the deploy user's shell rc, so this only protects manual interventions, not the next CI deploy.)
   - **Proper.** Land a hotfix on `main` that rolls forward (a new tagged build that's known-good). The deploy pipeline then pulls the new `latest` and the issue is resolved by moving forward, not backward.

5. Open an issue capturing what broke and the recovery path. The point of rollback isn't to live there — it's to buy time to land a proper fix.

---

## How to trigger a manual deploy

Useful for: the first VPS bootstrap, redeploying after VPS env changes that don't touch the repo, or smoke-testing the workflow itself.

- **From the GitHub UI.** Repo → **Actions** → **deploy-worker** → **Run workflow** → branch `main` → **Run workflow**.
- **From `gh` CLI.** `gh workflow run deploy-worker.yml --ref main`.

`workflow_dispatch` runs the same two jobs in the same order as a push-triggered run. It builds a fresh image off the current `main` HEAD and rolls the VPS.

If you need to deploy a non-main branch (e.g. testing a deploy pipeline change), push the branch and dispatch with `--ref <branch>` — but be aware the **deploy** job still does `git reset --hard origin/main` on the VPS, so the compose file pulled there will be `main`'s. That mismatch is intentional: the image can be a feature build, but the topology is always `main`.

---

## Where logs land

| Logs                                  | Where                                                                                                          |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Build + push                          | GitHub Actions run page → `build-and-push` job. Buildx output is verbose; expand the relevant step.            |
| SSH deploy step output                | GitHub Actions run page → `deploy` job. Shows the remote script's stdout/stderr inline.                        |
| Worker container logs (live)          | On the VPS: `cd /opt/voxhorizon && docker compose logs --tail=200 -f worker`.                                  |
| Worker container logs (post-failure)  | The deploy script dumps the last 200 lines into the Actions log on healthcheck failure. Easier than SSHing in. |
| `/opt/voxhorizon/.env` change history | Git is NOT tracking this file. Audit trail is whatever the operator pastes into the PR / issue when rotating.  |
| GHCR push events                      | Repo → **Packages** → **voxhorizon-worker** → **Activity**.                                                    |

For deeper triage (Caddy, Postgres-side, Supabase platform), see [`infra/monitoring/README.md`](../monitoring/README.md#alert-runbook).

---

## VPS prerequisites

Before the workflow can succeed against a brand-new VPS, the operator needs to provision:

1. The `deploy` user — see [`infra/deploy/setup-deploy-user.sh`](./setup-deploy-user.sh).
2. The `/opt/voxhorizon/` directory, owned by `deploy:deploy`, containing:
   - `.env` (chmod 600) — see [`SECRETS.md`](../../SECRETS.md#vps-production-secrets).
   - A git clone of this repo (any branch — the workflow's `git reset --hard origin/main` will normalise it).
3. Docker + Docker Compose v2 installed and the `deploy` user added to the `docker` group.
4. The deploy public key appended to `~deploy/.ssh/authorized_keys` — see [`SECRETS.md`](../../SECRETS.md#github-actions-deploy-secrets) for the recommended `from=` / option-flag restriction.

The repo secrets `VPS_HOST`, `VPS_USER`, `VPS_SSH_KEY` need to be set in GitHub before the first run will succeed.

---

## Out of scope (today)

- Blue/green or canary rollout. We have one worker container; the rollout is in-place with a healthcheck gate. Acceptable for v1.
- Staging environment. Production-only. A staging tier would add a second VPS + a second set of secrets — defer until multi-operator or compliance demands it.
- Automated rollback on healthcheck failure. The workflow exits non-zero and alerts via Actions notification; the operator chooses whether to roll back or roll forward. Worth revisiting once we have more deploy throughput.
- Deploy notifications (Slack / email beyond GitHub's default). Project decision: no Slack reintegration. Email-on-failure from GitHub Actions is enough for one operator.
