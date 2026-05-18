# Deploy

The contract between this repo and the VPS that runs the production stack. If the workflow ([`.github/workflows/deploy-stack.yml`](../../.github/workflows/deploy-stack.yml)) ever drifts from what's documented here, fix one or the other so they agree.

Companion docs: [`ARCHITECTURE.md`](../../ARCHITECTURE.md#deployment-pipeline), [`SECRETS.md`](../../SECRETS.md#github-actions-deploy-secrets), [`infra/monitoring/README.md`](../monitoring/README.md).

---

## First-time VPS bootstrap

The first time Diogo provisions a new Hostinger VPS, [`bootstrap-vps.sh`](./bootstrap-vps.sh) takes a freshly imaged Ubuntu 24.04 LTS box and brings it to the point where `docker compose up -d` can run. The script is idempotent — re-running on a partially-provisioned box only does the steps that haven't been done yet.

### How to run it

Preferred (download, inspect, then run):

```bash
ssh root@<vps-host>
curl -fsSL https://raw.githubusercontent.com/pveloso01/Diogo-Silva-VoxHorizon-Marketing-Control-Panel/main/infra/deploy/bootstrap-vps.sh \
  -o /root/bootstrap-vps.sh
less /root/bootstrap-vps.sh                # read it before executing
bash /root/bootstrap-vps.sh
```

One-liner (only if you trust the source and have already inspected the script once):

```bash
curl -fsSL https://raw.githubusercontent.com/pveloso01/Diogo-Silva-VoxHorizon-Marketing-Control-Panel/main/infra/deploy/bootstrap-vps.sh | sudo bash
```

Useful flags:

- `--dry-run` — print every command via `set -x` and skip `docker compose pull` / `up -d`. Safe to run for review.
- `--skip-firewall` — don't touch UFW (e.g. inside a container or a VPS where the firewall is already managed elsewhere).
- `--repo-url <url>` — override the repo clone URL (e.g. when bootstrapping from a fork).

### What the script does

1. **Sanity check.** Confirms the OS is Ubuntu 24.04 LTS; refuses to run on anything else.
2. **Base apt packages.** Installs `ca-certificates`, `curl`, `gnupg`, `ufw` if missing.
3. **Docker.** Installs `docker-ce`, `docker-ce-cli`, `containerd.io`, `docker-buildx-plugin`, `docker-compose-plugin` from Docker's official apt repo (not the older `docker.io` package). Enables and starts the `docker` service.
4. **UFW firewall.** Default deny incoming; opens TCP 22 (SSH), 80, 443, and UDP 443 (HTTP/3). `ufw --force enable`.
5. **Deploy user.** Calls [`setup-deploy-user.sh`](./setup-deploy-user.sh) (sibling script). Creates the `deploy` system user, adds it to the `docker` group, sets up `~deploy/.ssh`, creates `/opt/voxhorizon/` owned by `deploy:deploy` mode 750.
6. **Repo clone.** Clones the repo into `/opt/voxhorizon/repo` as the deploy user.
7. **`.env` scaffold.** Creates `/opt/voxhorizon/.env` by concatenating `worker/.env.example` and `web/.env.example` from the repo, with a leading banner noting every value must be filled in. `chmod 600`, `chown deploy:deploy`. **Real values are not filled in — that's a manual step.**
8. **Compose symlink.** Symlinks `/opt/voxhorizon/docker-compose.yml` → `/opt/voxhorizon/repo/docker-compose.yml` so `docker compose` can be run from `/opt/voxhorizon` directly. The `env_file: /opt/voxhorizon/.env` line in the compose file is an absolute path, so either CWD works — the symlink just makes the convention match the deploy workflow's `cd /opt/voxhorizon`.
9. **GHCR login.** Prints the manual instructions. The script does NOT bake a token; the operator runs `docker login ghcr.io -u <gh-user>` as the deploy user afterward.
10. **First pull.** `docker compose pull` (skipped in `--dry-run` or if `.env` is empty).
11. **First up.** `docker compose up -d` (skipped in `--dry-run` or if `.env` is empty).
12. **Summary.** Prints what's done and what's left.

### Manual steps still required after the script

The script gets you to a running Docker host with the repo, compose file, and an empty-shaped `.env` in place. The following still have to happen manually before the dashboard will serve traffic:

- **Fill in `/opt/voxhorizon/.env`** with real values for every variable (see [`SECRETS.md`](../../SECRETS.md#vps-production-secrets)). Don't ship with anything that looks like `CHANGE_ME` or `your-...`.
- **Set `VOXHORIZON_DASHBOARD_HOST`** in `/opt/voxhorizon/.env` to the public hostname (e.g. `dashboard.voxhorizon.com`). Caddy uses it for TLS issuance.
- **Cloudflare DNS.** Add an A record for `dashboard.voxhorizon.com` pointing at the VPS public IP. Proxy ON (orange cloud). SSL/TLS mode: **Full (Strict)**. See [`SECRETS.md`](../../SECRETS.md#cloudflare-dns-setup-operator).
- **Log into GHCR** as the deploy user (one time): `sudo -u deploy -i` then `docker login ghcr.io -u <your-github-username>` and paste a classic PAT with `read:packages`.
- **Append the GitHub Actions deploy public key** to `/home/deploy/.ssh/authorized_keys` (format in [`SECRETS.md`](../../SECRETS.md#github-actions-deploy-secrets)).
- **Set the GitHub repo secrets** (`VPS_HOST`, `VPS_USER`, `VPS_SSH_KEY`, and the `NEXT_PUBLIC_*` build-time inputs). See [`SECRETS.md`](../../SECRETS.md#github-actions-deploy-secrets).
- **Trigger the first deploy** from a workstation: `gh workflow run deploy-stack.yml --ref main`.

---

## What gets deployed

v1 production is a single-host Docker Compose stack on one Hostinger VPS. Two application containers, fronted by Caddy:

| Service  | Image                                       | Public?   | Port (host)      | Purpose                                                         |
| -------- | ------------------------------------------- | --------- | ---------------- | --------------------------------------------------------------- |
| `caddy`  | `caddy:2-alpine`                            | yes       | `80/443/443-udp` | TLS termination + reverse proxy to `web` only.                  |
| `web`    | `ghcr.io/pveloso01/voxhorizon-web:<tag>`    | via Caddy | (none)           | Next.js 15 standalone server, port 3000 on the compose network. |
| `worker` | `ghcr.io/pveloso01/voxhorizon-worker:<tag>` | no        | (none)           | FastAPI worker, port 8000 on the compose network only.          |

The worker is reachable only at `http://worker:8000` over the Docker network. `WORKER_URL` in `/opt/voxhorizon/.env` is set to that value; the host firewall blocks inbound `:8000`.

---

## What the workflow does

`deploy-stack.yml` runs on every push to `main` that touches:

- `app/**`, `components/**`, `lib/**`, `hooks/**`, `middleware.ts`, `package.json`, `pnpm-lock.yaml`, `next.config.ts`, `Dockerfile` — anything that requires a web rebuild.
- `worker/**` — source, Dockerfile, dependency manifests.
- `Caddyfile` — TLS / routing in front of the dashboard.
- `docker-compose.yml` — service topology.
- `.github/workflows/deploy-stack.yml`, `.github/workflows/build-web.yml`, `.github/workflows/build-worker.yml` — the workflows themselves (self-deploys fixes).

Plus a manual `workflow_dispatch` trigger for bootstrap, hotfix, and validation runs.

The pipeline is three workflows working together:

1. **`build-web.yml`** — checks out the repo, sets up Buildx, logs into GHCR with the run's `GITHUB_TOKEN`, builds the repo-root `Dockerfile` (Next.js standalone), and pushes:
   - `ghcr.io/pveloso01/voxhorizon-web:latest`
   - `ghcr.io/pveloso01/voxhorizon-web:<commit-sha>`

   `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, and `NEXT_PUBLIC_VAPID_PUBLIC_KEY` are passed as Docker `--build-arg`s from GitHub Actions repo secrets (see [`SECRETS.md`](../../SECRETS.md#github-actions-deploy-secrets)). Next.js inlines them at compile time.

2. **`build-worker.yml`** — checks out the repo, sets up Buildx, logs into GHCR, builds `worker/Dockerfile` (context: `worker/`), and pushes:
   - `ghcr.io/pveloso01/voxhorizon-worker:latest`
   - `ghcr.io/pveloso01/voxhorizon-worker:<commit-sha>`

   The worker reads every secret at runtime from `/opt/voxhorizon/.env`. No build-time secrets.

   Both build jobs use GHA-backed build cache (`cache-from: type=gha`, `cache-to: type=gha,mode=max`) so repeat builds reuse layers.

3. **`deploy-stack.yml`** — after either or both build jobs succeed, SSHes into `${{ secrets.VPS_HOST }}` as `${{ secrets.VPS_USER }}` using `${{ secrets.VPS_SSH_KEY }}` and runs (under `set -euo pipefail`):

   ```bash
   cd /opt/voxhorizon
   echo "$GITHUB_TOKEN" | docker login ghcr.io -u "$GH_ACTOR" --password-stdin
   git fetch --quiet origin main
   git reset --hard origin/main           # sync compose file, Caddyfile
   docker compose pull                     # pulls whichever images have new digests
   docker compose up -d --remove-orphans   # rolls only services with new images
   # poll healthchecks for both web and worker for ~50s each
   docker image prune -f
   ```

   `docker compose up -d` is idempotent: services whose image digest hasn't changed are left running; only the affected container(s) restart. A worker-only change rolls only the worker; a web-only change rolls only the dashboard. The healthcheck loop reads `docker inspect --format='{{.State.Health.Status}}' <container>` for each service ten times with a 5s sleep. If either hasn't reported `healthy` by the end, the script dumps the last 200 log lines from the unhealthy service and exits non-zero so the workflow run fails loudly.

Concurrency: `group: deploy-stack`, `cancel-in-progress: false`. Two pushes in quick succession queue; we never kill a rollout mid-flight.

The `WEB_IMAGE_TAG` and `WORKER_IMAGE_TAG` env vars in `docker-compose.yml` default to `latest`, so `docker compose pull` resolves to the freshly-pushed images without any per-deploy templating. Pinning either to a specific SHA is the per-service rollback path (next section).

---

## Manual rollback (per-service)

You're on the VPS, the latest rollout is bad, you need the previous green build back. **Because each container has its own image tag, you can roll back only the bad service** — no need to revert both containers when only one is broken.

### Roll back ONLY web

The dashboard is broken; the worker is fine.

1. Find the previous web SHA. Either:
   - GitHub Actions history (last green `build-web.yml` run before the bad one) and copy the commit SHA.
   - Or the GHCR tags page: `https://github.com/pveloso01/Diogo-Silva-VoxHorizon-Marketing-Control-Panel/pkgs/container/voxhorizon-web`.

2. SSH in and pin **only** the web container:

   ```bash
   ssh deploy@<vps-host>
   cd /opt/voxhorizon
   # Pull the rollback image explicitly so it's local
   docker compose pull ghcr.io/pveloso01/voxhorizon-web:<prev-web-sha>
   # Roll only the web service to the pinned tag (worker stays on current)
   WEB_IMAGE_TAG=<prev-web-sha> docker compose up -d web
   # Confirm
   docker compose ps
   docker inspect --format='{{.State.Health.Status}}' "$(docker compose ps -q web)"
   ```

3. Verify externally:

   ```bash
   curl -fsS https://dashboard.voxhorizon.com/api/health   # → 200
   ```

### Roll back ONLY worker

The worker is broken; the dashboard is fine. (Caveat: a broken worker often surfaces as a broken dashboard from the user's perspective, but the container itself is healthy.)

1. Find the previous worker SHA (analogous to above, in the `voxhorizon-worker` GHCR package).

2. SSH in and pin **only** the worker container:

   ```bash
   ssh deploy@<vps-host>
   cd /opt/voxhorizon
   docker compose pull ghcr.io/pveloso01/voxhorizon-worker:<prev-worker-sha>
   WORKER_IMAGE_TAG=<prev-worker-sha> docker compose up -d worker
   # Confirm
   docker compose ps
   docker inspect --format='{{.State.Health.Status}}' "$(docker compose ps -q worker)"
   ```

3. Verify the worker is healthy via the dashboard:

   ```bash
   curl -fsS https://dashboard.voxhorizon.com/api/worker/health   # → 200 (proxies through web)
   ```

### Roll back BOTH

If a stack-wide compose change went bad (e.g. a Caddyfile or `docker-compose.yml` change), git-revert the offending commit on `main` and let the deploy pipeline roll forward — that's cleaner than pinning two SHAs by hand. If you must pin both to specific SHAs simultaneously:

```bash
WEB_IMAGE_TAG=<prev-web-sha> WORKER_IMAGE_TAG=<prev-worker-sha> docker compose up -d
```

### Making a rollback stick

If you leave `WEB_IMAGE_TAG` / `WORKER_IMAGE_TAG` unset in subsequent ad-hoc commands, the next CI deploy will overwrite the rollback by pulling `latest` again. Two options:

- **Quick.** Export the var(s) in the deploy user's shell so subsequent ad-hoc `docker compose` calls pin: `echo 'export WORKER_IMAGE_TAG=<prev-sha>' >> ~/.bashrc`. The GH Actions workflow does **not** source the deploy user's shell rc, so this only protects manual interventions, not the next CI deploy.
- **Proper.** Land a hotfix on `main` that rolls forward (a new tagged build that's known-good). The deploy pipeline then pulls the new `latest` and the issue is resolved by moving forward, not backward.

Open an issue capturing what broke and the recovery path. The point of rollback isn't to live there — it's to buy time to land a proper fix.

---

## How to trigger a manual deploy

Useful for: the first VPS bootstrap, redeploying after VPS env changes that don't touch the repo, or smoke-testing the workflow itself.

- **From the GitHub UI.** Repo → **Actions** → **deploy-stack** → **Run workflow** → branch `main` → **Run workflow**.
- **From `gh` CLI.** `gh workflow run deploy-stack.yml --ref main`.

`workflow_dispatch` runs the same sequence as a push-triggered run: it triggers both build workflows (or whichever ones are wired to also run on dispatch), then `deploy-stack.yml` rolls the stack with whatever's currently `latest` in GHCR.

If you need to deploy a non-main branch (e.g. testing a deploy pipeline change), push the branch and dispatch with `--ref <branch>` — but be aware the **deploy** job still does `git reset --hard origin/main` on the VPS, so the compose file pulled there will be `main`'s. That mismatch is intentional: the image can be a feature build, but the topology is always `main`.

---

## Where logs land

| Logs                                  | Where                                                                                                             |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Build + push (web)                    | GitHub Actions run page → `build-web` job. Buildx output is verbose; expand the relevant step.                    |
| Build + push (worker)                 | GitHub Actions run page → `build-worker` job. Same shape as web.                                                  |
| SSH deploy step output                | GitHub Actions run page → `deploy` job. Shows the remote script's stdout/stderr inline.                           |
| Web container logs (live)             | On the VPS: `cd /opt/voxhorizon && docker compose logs --tail=100 -f web`.                                        |
| Worker container logs (live)          | On the VPS: `cd /opt/voxhorizon && docker compose logs --tail=100 -f worker`.                                     |
| Both at once (interleaved)            | `cd /opt/voxhorizon && docker compose logs --tail=100 -f web worker`.                                             |
| Worker container logs (post-failure)  | The deploy script dumps the last 200 lines into the Actions log on healthcheck failure. Easier than SSHing in.    |
| Caddy access + error logs             | On the VPS: `docker compose logs --tail=100 caddy` (also persisted via the `voxhorizon-caddy-logs` named volume). |
| `/opt/voxhorizon/.env` change history | Git is NOT tracking this file. Audit trail is whatever the operator pastes into the PR / issue when rotating.     |
| GHCR push events                      | Repo → **Packages** → **voxhorizon-web** / **voxhorizon-worker** → **Activity**.                                  |

For deeper triage (Caddy, Postgres-side, Supabase platform), see [`infra/monitoring/README.md`](../monitoring/README.md#alert-runbook).

---

## VPS prerequisites

Before the workflow can succeed against a brand-new VPS, the operator needs to provision:

1. The `deploy` user — see [`infra/deploy/setup-deploy-user.sh`](./setup-deploy-user.sh).
2. The `/opt/voxhorizon/` directory, owned by `deploy:deploy`, containing:
   - `.env` (chmod 600) — see [`SECRETS.md`](../../SECRETS.md#vps-production-secrets) for the full union of web + worker variables.
   - A git clone of this repo (any branch — the workflow's `git reset --hard origin/main` will normalise it).
3. Docker + Docker Compose v2 installed and the `deploy` user added to the `docker` group.
4. The deploy public key appended to `~deploy/.ssh/authorized_keys` — see [`SECRETS.md`](../../SECRETS.md#github-actions-deploy-secrets) for the recommended `from=` / option-flag restriction.
5. Cloudflare DNS A record `dashboard.voxhorizon.com` → VPS public IP, proxy ON, SSL/TLS Full (strict). See [`SECRETS.md`](../../SECRETS.md#cloudflare-dns-setup-operator).

The repo secrets `VPS_HOST`, `VPS_USER`, `VPS_SSH_KEY`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `NEXT_PUBLIC_VAPID_PUBLIC_KEY` need to be set in GitHub before the first run will succeed.

---

## Out of scope (today)

- Blue/green or canary rollout. We have one of each container; rollout is in-place with a healthcheck gate. Acceptable for v1.
- Staging environment. Production-only. A staging tier would add a second VPS + a second set of secrets — defer until multi-operator or compliance demands it.
- Automated rollback on healthcheck failure. The workflow exits non-zero and alerts via Actions notification; the operator chooses whether to roll back or roll forward. Worth revisiting once we have more deploy throughput.
- Deploy notifications (Slack / email beyond GitHub's default). Project decision: no Slack reintegration. Email-on-failure from GitHub Actions is enough for one operator.
- Horizontal scaling. One VPS, one of each container. Multi-host is post-v1.
