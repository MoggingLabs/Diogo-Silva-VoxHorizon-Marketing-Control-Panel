# Secrets

Single source of truth for every credential the VoxHorizon Marketing Control Panel touches. What it is, where it lives, what it's used for, who can rotate it, and how often. Companion to [`SETUP.md`](./SETUP.md).

---

## Security model

v1 is a single-operator system. The threat model is deliberately narrow:

- **Network boundary: Caddy + Cloudflare.** The VPS runs Caddy as the only externally-exposed service (`:80` / `:443` / `:443-udp`). Caddy fronts only the dashboard at `dashboard.voxhorizon.com`; the worker container has no public port binding. Cloudflare's proxy (orange cloud, SSL/TLS Full strict) is the outermost layer; the host firewall blocks every other inbound port.
- **App boundary: none in v1.** No Supabase Auth, no NextAuth, no SSO challenge. The dashboard is reachable on the public internet at `dashboard.voxhorizon.com` — protected only by obscurity of the URL + the fact that every state-changing operation requires the worker bearer (which the browser never sees). Adding an auth layer (e.g. Cloudflare Access, basic-auth on the Caddy site) is a v2 hardening step, not v1 scope.
- **Worker boundary: shared-secret bearer + internal-only network.** Every request from the dashboard's API routes to the worker carries `Authorization: Bearer <WORKER_SHARED_SECRET>`. Comparison is constant-time (`hmac.compare_digest`). The web→worker hop is internal to the Docker network (`http://worker:8000`) — the bearer never crosses the public internet. The b-roll signed-URL streaming route is the only exception — it uses its own HMAC scheme over `(clip_id, expiry)`.
- **Database boundary: service role + RLS off.** RLS is off in v1 (single operator). All writes go through the worker or the dashboard's API routes using the service-role key. If multi-operator access is ever introduced, an RLS migration is the entry point — but that's out of v1 scope.
- **File boundary: private buckets + signed URLs.** The `creatives` Supabase Storage bucket is private; reads happen through signed URLs minted by the worker (lands in M2).
- **Secrets at rest: gitignored `.env` files + chmod 600 vault files.** No secrets in git, ever. `.env`, `.env.local`, `.env.production` are blocked by `.gitignore`; only `.env.example` templates are committed.
- **Build vs runtime separation.** Build-time secrets (`NEXT_PUBLIC_*` values that Next.js inlines at compile time) live in GitHub Actions repo secrets and are injected as `--build-arg`s during `docker build`. Runtime secrets live in `/opt/voxhorizon/.env` on the VPS, mounted into both containers via `env_file:`. The two sets do not overlap.
- **Whitespace cleanup: `cleanEnv()`.** Both `lib/env.ts` (Next.js) and `worker/src/config.py` (Python) strip whitespace from every env value at read time. Dashboard copy-paste with a stray `\n` won't corrupt a Supabase URL or break the bearer compare.

---

## Inventory

Every secret in the system. **Vault** = `~/.config/voxhorizon/*.json` on Diogo's dev machine (chmod 600), backed by 1Password as the offline canonical copy.

Two distinct deployment surfaces:

- **GH Actions repo secrets (build-time)** — values injected into `docker build` via `--build-arg`. Used for `NEXT_PUBLIC_*` vars that Next.js inlines at compile time.
- **`/opt/voxhorizon/.env` on the VPS (runtime)** — values mounted into both `web` and `worker` containers via `env_file:`. Used for every server-side secret.

| Name                                    | Location                                                                                                          | Used for                                             | Rotated by                                                                | Cadence                                                            |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `NEXT_PUBLIC_SUPABASE_URL`              | GH Actions secret (build) + `/opt/voxhorizon/.env` (runtime, web container) + `.env.local` + Vault                | Supabase JS client (browser + server)                | Supabase dashboard                                                        | Never (URL is stable)                                              |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY`         | GH Actions secret (build) + `/opt/voxhorizon/.env` (runtime, web container) + `.env.local` + Vault                | Browser Supabase client                              | Supabase dashboard → Project Settings → API → Rotate                      | On suspected leak (rebuild + redeploy required)                    |
| `SUPABASE_SERVICE_ROLE_KEY`             | `/opt/voxhorizon/.env` (runtime, both containers) + `.env.local` + `worker/.env` + Vault                          | Server-side admin client; bypasses RLS               | Supabase dashboard                                                        | Quarterly + on suspected leak                                      |
| `SUPABASE_PUBLISHABLE_KEY` (sb_pub)     | Vault only                                                                                                        | Modern publishable key (optional for some SDK paths) | Supabase dashboard                                                        | Quarterly                                                          |
| `WORKER_URL`                            | `/opt/voxhorizon/.env` (runtime, web container only) — value is `http://worker:8000`                              | Dashboard reaches the worker over the Docker network | n/a (internal hostname)                                                   | Never (stable on the compose network)                              |
| `WORKER_SHARED_SECRET`                  | `/opt/voxhorizon/.env` (runtime, both containers) + `worker/.env` + Vault                                         | Bearer token between web ↔ worker                    | Manual regen (`python -c "import secrets; print(secrets.token_hex(64))"`) | Quarterly + on suspected leak                                      |
| `NEXT_PUBLIC_VAPID_PUBLIC_KEY`          | GH Actions secret (build) + `/opt/voxhorizon/.env` (runtime, web container) + `.env.local` + Vault (`vapid.json`) | Browser subscribes to Web Push                       | Manual regen via `npx web-push generate-vapid-keys`                       | **Never unless leaked.** Re-subscribing every client is expensive. |
| `VAPID_PRIVATE_KEY`                     | `/opt/voxhorizon/.env` (runtime, both containers) + `.env.local` + Vault (`vapid.json`)                           | Server signs push payloads                           | Same as above                                                             | Same as above                                                      |
| `RESEND_API_KEY`                        | `/opt/voxhorizon/.env` (runtime, web container) + Vault                                                           | Transactional email                                  | Resend dashboard                                                          | Quarterly                                                          |
| `KIE_AI_API_KEY`                        | `/opt/voxhorizon/.env` (runtime, worker container) + `worker/.env` (dev)                                          | Image generation (GPT Image 2)                       | Kie.ai dashboard                                                          | Quarterly                                                          |
| `ELEVENLABS_API_KEY`                    | `/opt/voxhorizon/.env` (runtime, worker container) + `worker/.env` (dev)                                          | Voiceover synthesis                                  | ElevenLabs dashboard → API Keys                                           | Quarterly                                                          |
| `SUBMAGIC_API_KEY`                      | `/opt/voxhorizon/.env` (runtime, worker container) + `worker/.env` (dev)                                          | Caption generation                                   | Submagic dashboard                                                        | Quarterly                                                          |
| `HYPERFRAMES_API_KEY`                   | `/opt/voxhorizon/.env` (runtime, worker container) + `worker/.env` (dev)                                          | Video composition (b-roll + voiceover)               | Hyperframes dashboard                                                     | Quarterly (lands in V2)                                            |
| `META_ADS_API_KEY` + `META_AD_ACCOUNTS` | `/opt/voxhorizon/.env` (runtime, worker container) + `worker/.env` (dev)                                          | Meta Ads performance pulls                           | Meta Business → System Users → Generate Token                             | Quarterly                                                          |
| GHL credentials (`GHL_*`)               | `/opt/voxhorizon/.env` (runtime, worker container) + `worker/.env` (dev)                                          | GoHighLevel pipeline pulls                           | GHL → Settings → Private Integrations                                     | Quarterly                                                          |
| Google Drive OAuth (gog)                | On-disk OAuth state under `~/.config/gog/` on the VPS, mounted into the worker container                          | Drive mirror uploads                                 | `gog auth login` re-auth                                                  | When expired (typically every few months)                          |
| GitHub PAT (Pedro's)                    | `~/.config/github/token` (chmod 600) on dev box                                                                   | API calls for issues/PRs/labels                      | github.com/settings/tokens                                                | Quarterly                                                          |
| `ANTHROPIC_API_KEY`                     | `/opt/voxhorizon/.env` (runtime, worker container) + Vault                                                        | Claude Code runner inside the worker                 | console.anthropic.com → API Keys                                          | Quarterly                                                          |
| Supabase DB password                    | Vault (`supabase.json`)                                                                                           | Direct psql / pooler access (not used in app code)   | Supabase dashboard → Database                                             | On suspected leak                                                  |

> **`NEXT_PUBLIC_*` rotation requires a CI rebuild + redeploy, not just a container restart.** Next.js inlines these values into the client bundle at build time. Restarting the `web` container with a new env var has no effect on the already-built JavaScript — you must bump the GH Actions secret, trigger a rebuild of `voxhorizon-web`, and roll the container to the new image tag. See the [GitHub Actions deploy secrets](#github-actions-deploy-secrets) section below for the build-arg handling.

### Reference IDs (not secrets, but important)

| Name                                  | Location                                     | What it is                                                                           |
| ------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------ |
| Supabase project ref                  | `jfzxlsaywztlytnobgej`                       | The project ID for the live us-east-1 deployment                                     |
| Supabase region                       | `us-east-1`                                  | Geographically close to the Hostinger VPS region                                     |
| Meta ad account (shared)              | `act_1209158034034659`                       | Aquarium + Dinero share this; split is encoded in `CAMPAIGN_FILTERS`. Do not change. |
| Drive root folder ID (marketing dept) | Per `MARKETING-DEPT-MAP.md` §9 in upstream   | Existing folder tree; reused by the Drive mirror                                     |
| Dashboard hostname                    | `dashboard.voxhorizon.com`                   | The only public hostname for the single-host stack. Caddy fronts only this.          |
| Worker hostname (internal)            | `worker` (Docker DNS) → `http://worker:8000` | Resolves on the compose network; never resolves on the public internet.              |

---

## Rotation cadence

| Trigger                | Action                                                                                                                                         |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Quarterly review       | Rotate all long-lived API keys (Supabase service role, Resend, Kie, ElevenLabs, Submagic, Meta, GHL, GitHub PAT, Anthropic).                   |
| Suspected leak         | Rotate immediately. Audit `git log` (see below). Rotate any secret with a non-trivial blast radius first (service role, worker shared secret). |
| Vendor rotation prompt | Honor it. Update vault, GH Actions secrets (if build-time), and `/opt/voxhorizon/.env` on the VPS together.                                    |
| Operator change        | Not applicable in v1 (single operator). Pre-handoff checklist: rotate every secret, re-issue Pedro's PAT, re-auth `gog` and Claude Code.       |

VAPID keys are intentionally **never rotated on a schedule.** Rotation forces every Web Push subscriber to re-subscribe. Only rotate on confirmed leak.

---

## Auditing

The repo's `.gitignore` blocks `.env*` (except `.env.example`). Even so, run a periodic grep across history to confirm no secret leaked into a tracked file:

```bash
git log -p --all --full-history -S 'eyJ' | head    # JWT-shaped strings (Supabase keys)
git log -p --all --full-history -S 'sb_' | head    # Supabase publishable / service-role prefixes
git log -p --all --full-history -S 'sbp_' | head   # Supabase personal access tokens
git log -p --all --full-history -S 'ghp_' | head   # GitHub PATs
git log -p --all --full-history -S 'sk-' | head    # Generic API key prefix (OpenAI-style)
git log -p --all --full-history -S 'AKIA' | head   # AWS access key prefix
git log -p --all --full-history -S 're_' | head    # Resend key prefix
```

All should return empty. A future hardening step (post-v1) is a pre-commit hook that runs `gitleaks` or `trufflehog` and refuses commits containing detected secrets. Until then, manual diligence + `.gitignore` is the only guard.

---

## Things that look like secrets but aren't

- **`NEXT_PUBLIC_SUPABASE_ANON_KEY`** ships to the browser. That's fine — Supabase's anon key is gated by RLS server-side. v1 has RLS off (single operator), but the worker and the dashboard's API routes are the gate (network boundary + worker bearer + service-role-only writes), not the key.
- **`NEXT_PUBLIC_VAPID_PUBLIC_KEY`** is a server-identifier shared with push services. Public by design.
- **Dashboard hostname** (`dashboard.voxhorizon.com`) is publicly resolvable. Knowing it gets you the login-less dashboard, but every state-changing operation requires the worker bearer (held server-side only).
- **Supabase project URL** (`https://jfzxlsaywztlytnobgej.supabase.co`) is publicly resolvable. Knowing it gets you nothing without a key.
- **Meta ad account IDs** are visible in the Meta Business UI to anyone with access. The API key is the real boundary.
- **Drive folder IDs** are visible in any URL the operator shares. ACLs gate read access; the IDs are just pointers.

---

## On-disk vault layout (dev machine)

Recommended structure under `~/.config/voxhorizon/` (chmod 600 on each file):

```
~/.config/voxhorizon/
├── supabase.json    # url, anon, service_role, publishable, db_password
├── vapid.json       # public, private (one-shot generation, never rotates)
├── worker.json      # shared_secret
├── resend.json      # api_key, sender_domain
└── README.txt       # plain-text pointer to 1Password for the canonical copy
```

```bash
mkdir -p ~/.config/voxhorizon
chmod 700 ~/.config/voxhorizon
chmod 600 ~/.config/voxhorizon/*.json
```

The vault is **not** an authoritative source for production — `/opt/voxhorizon/.env` on the VPS (runtime) and GitHub Actions repo secrets (build-time) are. The vault exists so a fresh dev-machine bootstrap doesn't require digging through 1Password mid-recipe.

---

## Quick "I think a secret leaked" runbook

1. **Confirm scope.** Which secret? Where was it exposed (commit, screenshot, log, third-party service)? Is it a build-time `NEXT_PUBLIC_*` value or a runtime value?
2. **Rotate at source.** Supabase / Resend / Kie / etc. dashboards each have a "rotate / revoke" button. Use it.
3. **Update everywhere it's referenced.**
   - **Runtime value:** edit `/opt/voxhorizon/.env` on the VPS, vault file, 1Password. Then `docker compose up -d <service>` to restart the affected container(s).
   - **Build-time value (`NEXT_PUBLIC_*`):** update the GitHub Actions repo secret, vault file, 1Password. Then trigger a `build-web.yml` rebuild + a `deploy-stack.yml` rollout. **A container restart alone is not enough** — see the callout under [Inventory](#inventory).
4. **Smoke test.** `curl https://dashboard.voxhorizon.com/api/health` → 200; if 401 on a worker-touching endpoint, the new shared secret didn't sync to one side.
5. **Post-mortem.** Write down in a Tracker comment: what leaked, how it leaked, what changed in handling.

---

## VPS production secrets

v1 production is a single-host Docker Compose stack on one Hostinger VPS: two containers (`web` and `worker`) plus Caddy. **`/opt/voxhorizon/.env` is a single file that serves both containers.** Both services mount it via `env_file:` in `docker-compose.yml`; each reads only the variables it needs. Secrets never live in the Docker images, never in git, and are never baked into builds.

### Where secrets live on the VPS

```
/opt/voxhorizon/
├── .env              # shared env file consumed by BOTH containers via env_file:
├── docker-compose.yml
└── Caddyfile
```

- **Path:** `/opt/voxhorizon/.env`
- **Owner:** `deploy:deploy`
- **Mode:** `chmod 600` (only the `deploy` user can read or write)
- **Mounted by:** both the `web` and `worker` services in `docker-compose.yml`. Each container is handed every line; the application code in each picks out the keys it cares about.
- **Template:** `.env.example` (at the repo root) lists the union of web + worker keys. Run the env-check scripts at container start (`worker/scripts/check-env.sh` for worker; equivalent in `lib/env.ts` for web) to fail fast on missing vars.
- **Build invariant:** neither the web nor the worker Dockerfile copies any `.env*` file into the image. Build-time `--build-arg`s for `NEXT_PUBLIC_*` values are different — see [GitHub Actions deploy secrets](#github-actions-deploy-secrets).
- **Git invariant:** `.gitignore` blocks every `.env*` pattern except `.env.example`. There is zero overlap between secret values and any tracked file.

### Full secret inventory (VPS runtime)

The union of every variable consumed by either container at runtime, grouped by concern. The **Consumed by** column tells you which container actually reads the value at runtime (some are shared).

#### Identity & routing (worker boundary)

| Var                    | Consumed by | Purpose                                                                                                                                                                                                  | Rotate at                                                                                                                              |
| ---------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `WORKER_URL`           | web         | Internal URL the dashboard uses to reach the worker. **Set to `http://worker:8000`** — Docker resolves the hostname `worker` on the compose network. Not a public URL; never reachable outside the host. | Only change if the worker service is renamed in `docker-compose.yml`.                                                                  |
| `WORKER_SHARED_SECRET` | web, worker | Bearer token compared (constant-time) on every web→worker request. **Both containers read the same value.**                                                                                              | Regenerate locally: `python -c "import secrets; print(secrets.token_hex(64))"`. Apply to `/opt/voxhorizon/.env`; roll both containers. |
| `WORKER_CORS_ORIGIN`   | worker      | CORS allow-origin for inbound calls. Should be `https://dashboard.voxhorizon.com` in production. Not secret.                                                                                             | Change if the dashboard hostname changes.                                                                                              |
| `WORKER_VERSION`       | worker      | Build / image tag surfaced on `/health`. Not secret.                                                                                                                                                     | Updated by the deploy pipeline.                                                                                                        |

#### Supabase

| Var                                         | Consumed by                                                                                   | Purpose                                                                                                                                                                                              | Rotate at                                                                                                                 |
| ------------------------------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_URL` | web (both names — server uses `NEXT_PUBLIC_SUPABASE_URL`, worker uses `SUPABASE_URL`), worker | Project endpoint. Public. `NEXT_PUBLIC_SUPABASE_URL` is **also** a build-time secret (see GH Actions section); the runtime copy must match.                                                          | Supabase dashboard → Project Settings → API. URL itself is stable.                                                        |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY`             | web (runtime mirror of the build-time value)                                                  | Browser Supabase client. Inlined into the bundle at build time; the runtime copy in `.env` exists so server-side Next.js code can reference the same value during SSR. Rotation requires CI rebuild. | Supabase dashboard → Project Settings → API → Rotate.                                                                     |
| `SUPABASE_SERVICE_ROLE_KEY`                 | web, worker                                                                                   | Service role JWT (bypasses RLS). Server-only. **Both containers read it.**                                                                                                                           | Supabase dashboard → Project Settings → API → Rotate service_role. Apply to `/opt/voxhorizon/.env`; roll both containers. |

#### Storage

| Var                   | Consumed by | Purpose                                                | Rotate at                    |
| --------------------- | ----------- | ------------------------------------------------------ | ---------------------------- |
| `BROLL_STORE_BACKEND` | worker      | `local` or `supabase`. Not secret.                     | Edit `/opt/voxhorizon/.env`. |
| `BROLL_LOCAL_ROOT`    | worker      | Filesystem path for the local b-roll pool. Not secret. | Edit `/opt/voxhorizon/.env`. |

#### Integrations: image

| Var              | Consumed by | Purpose                                | Rotate at                    |
| ---------------- | ----------- | -------------------------------------- | ---------------------------- |
| `KIE_AI_API_KEY` | worker      | Kie.ai (GPT Image 2) image generation. | Kie.ai dashboard → API Keys. |

#### Integrations: video

| Var                   | Consumed by | Purpose                          | Rotate at                                  |
| --------------------- | ----------- | -------------------------------- | ------------------------------------------ |
| `ELEVENLABS_API_KEY`  | worker      | Voiceover synthesis.             | ElevenLabs dashboard → Profile → API Keys. |
| `SUBMAGIC_API_KEY`    | worker      | Caption generation.              | Submagic dashboard → Settings → API.       |
| `HYPERFRAMES_API_KEY` | worker      | Video composition (lands in V2). | Hyperframes dashboard.                     |

#### Audit data sources

| Var                | Consumed by | Purpose                                                | Rotate at                                      |
| ------------------ | ----------- | ------------------------------------------------------ | ---------------------------------------------- |
| `META_ADS_API_KEY` | worker      | Meta Ads performance pulls.                            | Meta Business → System Users → Generate Token. |
| `META_AD_ACCOUNTS` | worker      | Comma-separated ad-account IDs. Not secret on its own. | Edit `/opt/voxhorizon/.env`.                   |
| `GHL_API_KEY`      | worker      | GoHighLevel pipeline / contact pulls.                  | GHL → Settings → Private Integrations.         |

#### Notifications

| Var                            | Consumed by                                  | Purpose                                                                                  | Rotate at                                                                             |
| ------------------------------ | -------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `RESEND_API_KEY`               | web                                          | Server-side transactional email.                                                         | Resend dashboard.                                                                     |
| `NEXT_PUBLIC_VAPID_PUBLIC_KEY` | web (runtime mirror of the build-time value) | Browser subscribes to Web Push. Inlined at build time; runtime copy for SSR consistency. | `npx web-push generate-vapid-keys`. **Do not rotate on a schedule** — see VAPID note. |
| `VAPID_PRIVATE_KEY`            | web                                          | Server signs Web Push payloads. Paired with `NEXT_PUBLIC_VAPID_PUBLIC_KEY`.              | Same as above.                                                                        |

#### Agent runtime

Claude Code was the v0 agent runtime and was **dropped during the Hermes integration milestone (May 2026)**. `ANTHROPIC_API_KEY` is no longer consumed by the worker; the live agent is `hermes-agent-ekko` on Hostinger's HVPS, and Hermes manages its own provider routing. The variable can be left present in `.env` (harmless) or removed at the next rotation pass.

| Var                          | Consumed by               | Purpose                                                                   | Rotate at                              |
| ---------------------------- | ------------------------- | ------------------------------------------------------------------------- | -------------------------------------- |
| `ANTHROPIC_API_KEY` (legacy) | — (unused after May 2026) | Legacy Claude Code runner. Safe to remove; left present to ease rollback. | n/a — drop on next quarterly rotation. |

#### Hermes integration secrets

Post-Hermes integration, the worker is a thin bridge between our dashboard and `hermes-agent-ekko`. Three new bearer tokens authenticate the three distinct surfaces; keeping them disjoint contains blast radius if one leaks. Plus a handful of routing / identity variables.

##### Worker-side (`/opt/voxhorizon/.env`)

| Var                         | Consumed by  | Purpose                                                                                                                                                                                                                     | Rotate at                                                                                                                         |
| --------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `HERMES_CONTAINER_NAME`     | worker       | Docker container name the worker addresses via `/var/run/docker.sock`. Defaults to `hermes-agent-ekko`. Not secret.                                                                                                         | Edit `/opt/voxhorizon/.env` only if Hostinger renames the container template.                                                     |
| `DASHBOARD_WEBHOOK_TOKEN`   | worker, Ekko | Bearer the worker requires on inbound `POST /work/hermes/webhook` calls. Ekko's `post_tool_call` / `session_end` shell hooks send it. **Must be identical on both sides.**                                                  | Regenerate locally (`python -c "import secrets; print(secrets.token_hex(48))"`); update both `.env` files; restart worker + Ekko. |
| `VOXHORIZON_APPROVAL_TOKEN` | worker, Ekko | Bearer the worker requires on inbound `POST /work/hermes/approval` calls from the `voxhorizon-approvals` plugin. **Distinct from `DASHBOARD_WEBHOOK_TOKEN`** so a compromise of one path can't pivot to the other.          | Same procedure as above.                                                                                                          |
| `INTERNAL_API_TOKEN`        | worker, web  | Bearer the worker carries when calling Next.js `/api/internal/*` (e.g. the high-urgency email render endpoint). The web container compares it with `hmac.compare_digest`.                                                   | Same procedure.                                                                                                                   |
| `INTERNAL_API_BASE_URL`     | worker       | Base URL the worker uses to reach the web container for internal calls. **Set to `http://web:3000`** on the compose network.                                                                                                | Only change if `web` is renamed in `docker-compose.yml`.                                                                          |
| `OPERATOR_EMAIL`            | web          | Resend recipient for high-urgency approval emails. Set to the operator's mailbox.                                                                                                                                           | Edit when the operator's email changes.                                                                                           |
| `VAPID_PUBLIC_KEY`          | worker       | Public half of the VAPID keypair the worker references when fanning out browser push for new approvals. **Same value as `NEXT_PUBLIC_VAPID_PUBLIC_KEY`**, mirrored here so the worker can construct subscription endpoints. | See VAPID note above — **do not rotate on a schedule**.                                                                           |
| `VAPID_PRIVATE_KEY`         | worker, web  | Server-side VAPID signer. Both containers consume it (web for `/api/push` flows, worker for approval fan-out).                                                                                                              | Same as above.                                                                                                                    |

> **`VAPID_PUBLIC_KEY` vs `NEXT_PUBLIC_VAPID_PUBLIC_KEY`.** They hold the same value. The browser subscribes using the `NEXT_PUBLIC_*` form (inlined at build time); the worker references `VAPID_PUBLIC_KEY` at runtime to identify the subscription origin in its push payloads. Both are derived from one `npx web-push generate-vapid-keys` invocation. Rotating either forces every subscriber to re-permission Web Push — see the VAPID note.

##### Ekko-side (`/opt/data/.env` on the VPS, inside the Hermes container)

These live on the Hermes container's filesystem, not in our `/opt/voxhorizon/.env`. The operator pastes them in during the one-shot Hermes overlay (see [`infra/deploy/README.md`](./infra/deploy/README.md#hermes-side-overlay-one-shot)).

| Var                              | Consumed by                              | Purpose                                                                                                               | Rotate at                                                                                       |
| -------------------------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `SUPABASE_URL`                   | Ekko (`dashboard-publish` skill helpers) | Project URL the skills hit when upserting rows.                                                                       | Stable; only changes if the Supabase project is migrated.                                       |
| `SUPABASE_SERVICE_ROLE_KEY`      | Ekko (`dashboard-publish` skill helpers) | Service-role key the skill helpers use. **Same value as the worker's** — Supabase has one canonical service-role key. | Rotate at Supabase dashboard; update `/opt/voxhorizon/.env` AND `/opt/data/.env`; restart both. |
| `DASHBOARD_WEBHOOK_URL`          | Ekko (shell hooks)                       | Where shell hooks post — should be `http://worker:8000/work/hermes/webhook` on the shared Docker daemon.              | Only change if the worker is renamed.                                                           |
| `DASHBOARD_WEBHOOK_TOKEN`        | Ekko (shell hooks)                       | Bearer paired with the worker-side `DASHBOARD_WEBHOOK_TOKEN`.                                                         | Rotate alongside the worker-side value.                                                         |
| `VOXHORIZON_APPROVAL_WORKER_URL` | Ekko (`voxhorizon-approvals` plugin)     | Where the plugin's HTTP client points — should be `http://worker:8000/work/hermes/approval`.                          | Only change if the worker is renamed.                                                           |
| `VOXHORIZON_APPROVAL_TOKEN`      | Ekko (`voxhorizon-approvals` plugin)     | Bearer paired with the worker-side `VOXHORIZON_APPROVAL_TOKEN`.                                                       | Rotate alongside the worker-side value.                                                         |

##### Docker socket trade-off

The worker container mounts `/var/run/docker.sock` read-write so it can `docker exec` into `hermes-agent-ekko` for the chat-streaming and kanban bridges. This is **root-equivalent access on the host** — anything that compromises the worker process can manipulate every container on the daemon, mount arbitrary host paths, and pivot off the box.

We accept the trade-off because the alternatives (network-only RPC into Hermes; sidecar shim that mediates Docker calls) sacrifice the <1ms latency that makes the chat experience livable. Mitigations:

- **Only the worker mounts the socket.** Neither `web` nor `caddy` has access.
- **Strict bearer auth on every worker route.** The worker has no unauthenticated public endpoint; every inbound call carries `WORKER_SHARED_SECRET` (from web) or `DASHBOARD_WEBHOOK_TOKEN` / `VOXHORIZON_APPROVAL_TOKEN` (from Ekko-side hooks/plugin).
- **No untrusted code paths in the worker.** Every dependency is pinned in `uv.lock`; the worker doesn't execute user-supplied scripts or accept arbitrary file uploads.
- **Co-located by design.** Worker + Ekko + dashboard live in one operator-controlled environment. The threat model is "compromise of one of our images via a supply-chain attack," not "untrusted code escaping a sandbox."
- **`docker` group, not root.** The compose file pins the worker into the host's `docker` group via `group_add`, so the `app` user inside the container can use the socket without running as UID 0.

If the threat model widens (multi-tenant, third-party plugins running inside the worker, etc.), the right move is a tightly-scoped Docker proxy (e.g. `tecnativa/docker-socket-proxy`) that exposes only `containers.exec` for one container ID — not the full Docker API. Track that as a v2 hardening step.

#### Reverse proxy

| Var                   | Consumed by | Purpose                                                                                                                      | Rotate at                    |
| --------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| `VOXHORIZON_WEB_HOST` | Caddy       | Hostname Caddy obtains a Let's Encrypt cert for and matches in its Caddyfile. Set to `dashboard.voxhorizon.com`. Not secret. | Edit `/opt/voxhorizon/.env`. |

##### Cloudflare DNS setup (operator)

There is no Cloudflare credential to manage for v1 — Caddy speaks ACME directly to Let's Encrypt — but the operator's one-time Cloudflare wiring is recorded here so the dependency is auditable.

- **DNS.** Create an A record `dashboard.voxhorizon.com` → VPS public IP. Proxy status: **ON** (orange cloud). Cloudflare's edge fronts the user-facing TLS leg.
- **SSL/TLS mode.** Cloudflare dashboard → SSL/TLS → Overview → **Full (strict)**. Cloudflare validates the upstream Let's Encrypt cert that Caddy presents. _Flexible_ would terminate TLS at the edge and talk plaintext to Caddy — never use it. _Full_ (non-strict) would accept any cert from the origin including self-signed — avoid; Let's Encrypt makes strict trivial.
- **No API token required.** Cloudflare API tokens would only be needed if v2 moves to DNS-01 ACME challenges (e.g. for wildcard certs). v1 uses HTTP-01 over the Cloudflare edge, which works out of the box once the proxy is ON and SSL mode is Full (strict).
- **Cert renewal.** Caddy renews ~30 days before expiry. State persists in the `voxhorizon-caddy-data` named volume across container restarts.
- **No DNS for the worker.** The worker has no public hostname. Do not create a CNAME or A record for it — that would defeat the internal-only posture.

### VAPID note

`VAPID_PRIVATE_KEY` and its public counterpart `NEXT_PUBLIC_VAPID_PUBLIC_KEY` are **never rotated on a schedule.** The keypair identifies the push origin to every browser that has subscribed. Rotating the private key forces **every subscriber** to re-subscribe — the old push endpoint becomes unusable for the existing subscription records in `push_subscriptions`. Only rotate on confirmed leak, and only after planning the re-subscribe migration (clear `push_subscriptions`, prompt every active client to re-permission Web Push). Note `NEXT_PUBLIC_VAPID_PUBLIC_KEY` is also a build-time secret — rotating it requires a full `voxhorizon-web` rebuild + redeploy, not just a container restart.

### Quarterly rotation checklist

Run the first weekend of each quarter. Tick each box as you go.

- [ ] **Supabase service role.** Rotate at Supabase dashboard; update `/opt/voxhorizon/.env`; `docker compose up -d web worker` (both containers consume it). Use the rolling pattern (below) for zero downtime.
- [ ] **`WORKER_SHARED_SECRET`.** Regenerate (`python -c "import secrets; print(secrets.token_hex(64))"`); update `/opt/voxhorizon/.env`; `docker compose up -d web worker`. Rolling pattern applies.
- [ ] **Kie.ai (`KIE_AI_API_KEY`).** Rotate at kie.ai; update `/opt/voxhorizon/.env`; `docker compose up -d worker`.
- [ ] **ElevenLabs (`ELEVENLABS_API_KEY`).** Rotate at elevenlabs.io; update `/opt/voxhorizon/.env`; restart worker.
- [ ] **Submagic (`SUBMAGIC_API_KEY`).** Rotate at submagic.co; update `/opt/voxhorizon/.env`; restart worker.
- [ ] **Meta Ads (`META_ADS_API_KEY`).** Generate fresh System User token; update `/opt/voxhorizon/.env`; restart worker.
- [ ] **GoHighLevel (`GHL_API_KEY`).** Rotate at GHL → Settings → Private Integrations; update `/opt/voxhorizon/.env`; restart worker.
- [ ] **Anthropic (`ANTHROPIC_API_KEY`, legacy).** Hermes/Ekko is the live runtime now; remove `ANTHROPIC_API_KEY` from `/opt/voxhorizon/.env` if confident the rollback to Claude Code is no longer wanted.
- [ ] **Hermes bearer tokens (`DASHBOARD_WEBHOOK_TOKEN`, `VOXHORIZON_APPROVAL_TOKEN`, `INTERNAL_API_TOKEN`).** Regenerate each (`python -c "import secrets; print(secrets.token_hex(48))"`); update `/opt/voxhorizon/.env` AND (for the two Ekko-facing tokens) `/opt/data/.env` on the Hermes container; restart worker + Ekko. Distinct tokens — rotate together but never share values.
- [ ] **Resend (`RESEND_API_KEY`).** Rotate at resend.com; update `/opt/voxhorizon/.env`; `docker compose up -d web` (web container consumes it).
- [ ] **GitHub PAT (Pedro's).** Rotate at github.com/settings/tokens; update `~/.config/github/token` (chmod 600) on the dev box.
- [ ] **`NEXT_PUBLIC_*` build secrets.** Confirm none need rotating (URL is stable; anon key + VAPID public are "only on leak"). If rotation is required, update the GH Actions repo secret, trigger a `build-web.yml` rebuild, and roll the web container — **not** just `/opt/voxhorizon/.env`.
- [ ] **VAPID.** Skip unless leaked — see VAPID note above.
- [ ] **Audit.** Run the `git log -S` greps under [Auditing](#auditing) to confirm nothing leaked into history during the quarter.
- [ ] **Smoke test.** `curl https://dashboard.voxhorizon.com/api/health` → 200; trigger one end-to-end creative generation to confirm Kie + ElevenLabs + Submagic + Supabase paths all wired.

### Per-secret rotation procedure

The default flow for a runtime secret that lives in `/opt/voxhorizon/.env`:

1. **Generate the new value** at the provider dashboard (or, for `WORKER_SHARED_SECRET`, locally via `python -c "import secrets; print(secrets.token_hex(64))"`).
2. **SSH into the VPS** as `deploy`:

   ```bash
   ssh deploy@<vps-host>
   cd /opt/voxhorizon
   ```

3. **Edit the env file** (it is `chmod 600`, owned by `deploy`):

   ```bash
   sudo -u deploy ${EDITOR:-nano} /opt/voxhorizon/.env
   # change the single KEY= line; save
   ```

4. **Restart the container(s) that consume it.** If only the worker reads the var, restart just `worker`; same for web-only. For shared values (e.g. `WORKER_SHARED_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`), restart both:

   ```bash
   docker compose up -d worker            # worker-only var
   docker compose up -d web               # web-only var
   docker compose up -d web worker        # shared var
   docker compose logs --tail=50 worker   # confirm check-env.sh prints "env OK"
   docker compose logs --tail=50 web      # confirm Next.js comes up
   ```

5. **Smoke test.** `curl https://dashboard.voxhorizon.com/api/health` → 200. For provider-specific keys, trigger one operation that exercises that integration (e.g. a small Kie generation for `KIE_AI_API_KEY`).
6. **Revoke the old value** at the provider dashboard once the smoke passes.

> **`NEXT_PUBLIC_*` values are different.** They are inlined into the web container at build time and updating `/opt/voxhorizon/.env` alone has no effect on what the browser already received. For those, you must (a) update the GitHub Actions repo secret, (b) trigger a `voxhorizon-web` rebuild, (c) roll the deployed image. See the [GitHub Actions deploy secrets](#github-actions-deploy-secrets) section.

#### Shared secrets — rolling swap (no-downtime)

Two runtime secrets are read by **both** containers:

- `WORKER_SHARED_SECRET` — the bearer the web→worker calls use.
- `SUPABASE_SERVICE_ROLE_KEY` — the admin key both sides use to talk to Postgres.

Because both containers read the same `/opt/voxhorizon/.env` and `docker compose up -d` rolls them sequentially, there is a brief (~5–10s) window where one container has the new value and the other still has the old. For `WORKER_SHARED_SECRET` that means transient 401s; for `SUPABASE_SERVICE_ROLE_KEY` it means transient 5xx from one side. Both windows are short enough that for a single-operator system the simpler procedure is "rotate during a known idle moment, accept the brief blip." If a zero-downtime swap is required, use this rolling pattern:

1. **Generate the new value.** For `WORKER_SHARED_SECRET`, regen locally. For Supabase service role, rotate at Supabase dashboard but **do not** invalidate the old key yet (Supabase issues the new key alongside the old until you confirm).
2. **Add a parallel env var to `/opt/voxhorizon/.env`.**

   ```bash
   ssh deploy@<vps-host>
   sudo -u deploy ${EDITOR:-nano} /opt/voxhorizon/.env
   # Add: WORKER_SHARED_SECRET_NEXT=<new value>   (keep old WORKER_SHARED_SECRET intact)
   docker compose up -d web worker   # both containers now see both values
   ```

   App code reads only the active var; the `_NEXT` value is dormant. Confirm both containers came up healthy with `docker compose logs --tail=50 web worker`.

3. **Switch the worker to accept the new value first.** Patch the worker's auth comparison to accept either `WORKER_SHARED_SECRET` or `WORKER_SHARED_SECRET_NEXT` (a small temporary code change, or a config flag set in `.env`). Roll only the worker:

   ```bash
   docker compose up -d worker
   ```

4. **Promote the new value in the active var.**

   ```bash
   sudo -u deploy ${EDITOR:-nano} /opt/voxhorizon/.env
   # set WORKER_SHARED_SECRET=<new value>   (same as WORKER_SHARED_SECRET_NEXT)
   docker compose up -d web   # web now sends the new bearer
   ```

5. **Verify.** `curl https://dashboard.voxhorizon.com/api/health` → 200. Watch worker logs for 401s.
6. **Clean up.**
   - Remove `WORKER_SHARED_SECRET_NEXT` from `/opt/voxhorizon/.env`.
   - Revert the worker auth code to single-value comparison.
   - Roll worker again to apply the cleanup.
   - At the provider (Supabase), invalidate the old service-role JWT.

The same pattern applies to `SUPABASE_SERVICE_ROLE_KEY`: stage `SUPABASE_SERVICE_ROLE_KEY_NEXT`, teach the relevant client construction to fall back, promote, clean up, invalidate the old key.

> **Order matters.** Always: **stage the `_NEXT` value → teach the consumer to accept either → promote the active var → remove staging → revert consumer + invalidate at provider.**

### v2 upgrade path: `sops + age`

When the operator count goes above one — or when audit / compliance demands it — migrate to [`sops`](https://github.com/getsops/sops) with [`age`](https://github.com/FiloSottile/age) recipients for git-committed encrypted secrets:

- `.env` files are encrypted in place; the ciphertext is committed to the repo.
- Each operator has an `age` keypair; the public keys are listed in `.sops.yaml`.
- Decryption on the VPS happens at `docker compose up` via `sops exec-env` or a small entrypoint shim — no plaintext on disk longer than the process lifetime.
- Rotation becomes a `sops updatekeys` operation; new operators are onboarded by adding their public key and re-encrypting.

This is **not** v1 scope. v1's single-operator threat model is met by `chmod 600 /opt/voxhorizon/.env` + tight SSH ACLs. Revisit when (a) a second operator needs commit-level access, or (b) the worker fleet grows past one VPS and provisioning needs a shared, auditable source for the env file.

---

## GitHub Actions deploy secrets

Two image-build workflows (`build-web.yml`, `build-worker.yml`) build the two GHCR images on each push to `main`. A third workflow, `deploy-stack.yml` (renamed from `deploy-worker.yml` by VPS-10), SSHes into the VPS as the `deploy` user and rolls the compose stack. The workflows together need two categories of repo-level secret: **deploy credentials** (SSH + host info) and **build-time `NEXT_PUBLIC_*` values** (injected as Docker `--build-arg`s into the web image). Configure them at **Settings → Secrets and variables → Actions → New repository secret**.

### Deploy credentials

| Secret        | Purpose                                                                                                                 | How to populate                                                                                                                                                                         |
| ------------- | ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VPS_HOST`    | The DNS name or IP the workflow `ssh`s into. Not secret per se, but treat it as one so it's not in git.                 | Production hostname (e.g. `dashboard.voxhorizon.com`) or the bare VPS IP if DNS isn't wired yet. Match whatever resolves to the box.                                                    |
| `VPS_USER`    | The unprivileged Linux user the deploy script runs as. Must be in the `docker` group and own `/opt/voxhorizon`.         | Set to `deploy`. Provisioned by `infra/deploy/setup-deploy-user.sh` on a fresh VPS.                                                                                                     |
| `VPS_SSH_KEY` | The **private** half of a deploy-only SSH keypair. Used to authenticate the GitHub Actions runner into `deploy@<host>`. | Generate fresh: `ssh-keygen -t ed25519 -f ~/.ssh/voxhorizon_deploy -C "github-actions-deploy"`. Paste the **contents** of `~/.ssh/voxhorizon_deploy` (private key, with header/footer). |

### Build-time `NEXT_PUBLIC_*` secrets

Three additional secrets are passed to `build-web.yml` as Docker `--build-arg`s so Next.js can inline them into the client bundle during `pnpm build`. The web Dockerfile declares matching `ARG NEXT_PUBLIC_*` directives and exports them as build env so the standalone output captures them.

| Secret                          | Purpose                                                                                                                | How to populate                                                                                          |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `NEXT_PUBLIC_SUPABASE_URL`      | Project URL the browser Supabase client connects to. Inlined into the JS bundle.                                       | Copy from Supabase dashboard → Project Settings → API. Same value as in `/opt/voxhorizon/.env`.          |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Anon key the browser Supabase client uses. Inlined into the JS bundle.                                                 | Copy from Supabase dashboard → Project Settings → API → `anon` `public`. Same value as in the VPS .env.  |
| `NEXT_PUBLIC_VAPID_PUBLIC_KEY`  | VAPID public key the browser presents when subscribing to Web Push. Inlined into the service-worker registration code. | Copy from the keypair output of `npx web-push generate-vapid-keys` (one-shot generation, never rotates). |

> **Rotating any `NEXT_PUBLIC_*` value requires a CI rebuild + redeploy, not just a container restart, because Next.js inlines these at build time.** Updating the runtime `/opt/voxhorizon/.env` is necessary too (so server-side code sees the same value during SSR) but is **not sufficient** — the browser will keep receiving the old value until the `voxhorizon-web` image is rebuilt and rolled. Rotation sequence: (1) update the GH Actions repo secret, (2) update the matching line in `/opt/voxhorizon/.env`, (3) trigger `build-web.yml` (push or `workflow_dispatch`), (4) `deploy-stack.yml` rolls the new image, (5) hard-refresh the browser to bust the service-worker cache. The Supabase anon key in particular almost never rotates; VAPID public key never rotates on a schedule (see VAPID note above).

### Key handling — non-negotiables

- **Fresh ed25519 keypair, deploy-only.** Do **not** reuse Pedro's admin key, an existing personal key, or a workstation key. The deploy key is a single-purpose credential whose blast radius is "rollout the stack on this one VPS." Compromise of this key must not give shell access anywhere else.
- **No passphrase.** GitHub Actions can't type one. The key's protection is its scope (deploy-only) + the `from=` and `command=` restrictions on the authorized_keys line.
- **Private key in GHA secret only.** Never commit it. Never paste it into the vault or 1Password unless you also accept the rotation policy: rotating the GHA secret means rotating every other copy.
- **Public key on the VPS.** Append `~/.ssh/voxhorizon_deploy.pub` to `~deploy/.ssh/authorized_keys` on the VPS. Lock the line down:

  ```
  from="140.82.112.0/20,143.55.64.0/20,...",no-port-forwarding,no-agent-forwarding,no-X11-forwarding ssh-ed25519 AAAA... github-actions-deploy
  ```

  The `from=` CIDR list is GitHub's published Actions IP ranges (`https://api.github.com/meta` → `actions[]`). Refreshing this list quarterly is part of the rotation checklist below.

  If pinning IPs is non-trivial at provisioning time (e.g. the list is large or the operator wants a faster bootstrap), it's acceptable to ship the first cut with just the option flags (`no-port-forwarding,no-agent-forwarding,no-X11-forwarding`) and follow up with the `from=` restriction once the workflow is proven end-to-end. **Track that as an explicit follow-up** — leaving an unrestricted deploy key in place indefinitely is not the target state.

- **`command=` restriction (optional, follow-up).** A tighter posture pins the key to a single forced command (`command="/opt/voxhorizon/deploy.sh"`) so even a compromised private key can only run the rollout script, not an arbitrary shell. The current workflow uses a multi-line inline `script:` block, so a `command=` restriction would require rewriting the workflow to either (a) call a deploy script the VPS already has, or (b) accept its arguments through `$SSH_ORIGINAL_COMMAND`. Worth doing post-v1; not blocking VPS-4.

### Rotation

| Trigger               | Action                                                                                                                                                                                               |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Quarterly review      | Regenerate the keypair (`ssh-keygen ...`); replace the line in `~deploy/.ssh/authorized_keys`; update `VPS_SSH_KEY` in GH repo secrets; trigger one `workflow_dispatch` run to confirm.              |
| Suspected leak        | Immediately remove the line from `authorized_keys` on the VPS; regenerate; update GH secret; redeploy. The blast radius is scoped to the deploy user and the worker stack, but treat it as serious.  |
| GitHub IP range drift | If the workflow starts failing with `Permission denied` from a previously-working setup, refresh the `from=` CIDR list against `https://api.github.com/meta`. Track this on the quarterly checklist. |

### Not a secret, but important

- **GHCR access** is via `GITHUB_TOKEN` (auto-provided to the workflow run). No additional PAT needed for `packages:write` against the same repo's GHCR namespace. The token is short-lived and scoped to the run.
- The VPS-side `docker login ghcr.io` inside the workflow uses the same `GITHUB_TOKEN` over stdin (`--password-stdin`); the credential exists on disk under `~deploy/.docker/config.json` between runs (chmod 600).

---

## External monitoring accounts (VPS-6)

External uptime monitors live alongside the secrets they alert on. None of them require API keys for v1 — they're all free-tier and configured via the web UI — so there's nothing to put in the vault except the dashboard URLs.

| Service              | Account                          | Dashboard                   | API key needed? | Notes                                                                                                                                        |
| -------------------- | -------------------------------- | --------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Uptime Robot         | `diogosilvaenterprise@gmail.com` | https://uptimerobot.com     | No (free tier)  | Polls `https://dashboard.voxhorizon.com/api/health` every 5 min. See [`infra/monitoring/README.md`](./infra/monitoring/README.md) for setup. |
| Healthchecks.io      | `diogosilvaenterprise@gmail.com` | https://healthchecks.io     | No              | One check per scheduled job. Ping URLs are per-check (treat like secrets — anyone with one can fake a heartbeat). Store on the VPS only.     |
| Supabase status page | (public, no account)             | https://status.supabase.com | No              | Email subscription added for `diogosilvaenterprise@gmail.com`; also mirrored in Uptime Robot as an independent monitor.                      |

The Healthchecks.io ping URLs are the only monitoring-related thing that needs handling — they live on the VPS inside the systemd unit files / wrapper scripts (lands with #59). Treat them like service credentials: don't commit them to git, copy them out of the Healthchecks dashboard at provisioning time.

See [`infra/monitoring/README.md`](./infra/monitoring/README.md) for the full setup runbook and alert response procedure.
