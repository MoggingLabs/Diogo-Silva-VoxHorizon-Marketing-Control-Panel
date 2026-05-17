# Secrets

Single source of truth for every credential the VoxHorizon Marketing Control Panel touches. What it is, where it lives, what it's used for, who can rotate it, and how often. Companion to [`SETUP.md`](./SETUP.md).

---

## Security model

v1 is a single-operator system. The threat model is deliberately narrow:

- **Network boundary: Tailscale.** The Mac running the worker is only reachable on the tailnet, except via the explicit **Tailscale Funnel** URL the Vercel app uses. Funnel exposes one HTTPS endpoint over the public internet; everything else is tailnet-only.
- **App boundary: Vercel Deployment Protection.** Production UI hits go through Vercel's SSO challenge — only members of Diogo's Vercel team can reach the deployed pages. No app-level auth (no Supabase Auth, no NextAuth) in v1. Decision: locked in M0-15.
- **Worker boundary: shared-secret bearer.** Every request from Vercel to the worker carries `Authorization: Bearer <WORKER_SHARED_SECRET>`. Comparison is constant-time (`hmac.compare_digest`). The b-roll signed-URL streaming route is the only exception — it uses its own HMAC scheme over `(clip_id, expiry)`.
- **Database boundary: service role + RLS off.** RLS is off in v1 (single operator). All writes go through the worker or Next.js server using the service-role key. If multi-operator access is ever introduced, an RLS migration is the entry point — but that's out of v1 scope.
- **File boundary: private buckets + signed URLs.** The `creatives` Supabase Storage bucket is private; reads happen through signed URLs minted by the worker (lands in M2).
- **Secrets at rest: gitignored `.env` files + chmod 600 vault files.** No secrets in git, ever. `.env`, `.env.local`, `.env.production` are blocked by `.gitignore`; only `.env.example` templates are committed.
- **Whitespace cleanup: `cleanEnv()`.** Both `lib/env.ts` (Next.js) and `worker/src/config.py` (Python) strip whitespace from every env value at read time. Dashboard copy-paste with a stray `\n` won't corrupt a Supabase URL or break the bearer compare.

---

## Inventory

Every secret in the system. **Vault** = `~/.config/voxhorizon/*.json` on Diogo's Mac (chmod 600), backed by 1Password as the offline canonical copy.

| Name                                    | Location                                                            | Used for                                               | Rotated by                                                                | Cadence                                                            |
| --------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `NEXT_PUBLIC_SUPABASE_URL`              | Vercel env + `.env.local` + Vault (`supabase.json`)                 | Supabase JS client (browser + server)                  | Supabase dashboard                                                        | Never (URL is stable)                                              |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY`         | Vercel env + `.env.local` + Vault (`supabase.json`)                 | Browser Supabase client                                | Supabase dashboard → Project Settings → API → Rotate                      | On suspected leak                                                  |
| `SUPABASE_SERVICE_ROLE_KEY`             | Vercel env (server-only) + `.env.local` + `worker/.env` + Vault     | Server-side admin client; bypasses RLS                 | Supabase dashboard                                                        | Quarterly + on suspected leak                                      |
| `SUPABASE_PUBLISHABLE_KEY` (sb_pub)     | Vault only                                                          | Modern publishable key (optional for some SDK paths)   | Supabase dashboard                                                        | Quarterly                                                          |
| `WORKER_SHARED_SECRET`                  | Vercel env + `worker/.env` + Vault                                  | Bearer token between Vercel ↔ worker                   | Manual regen (`python -c "import secrets; print(secrets.token_hex(64))"`) | Quarterly + on suspected leak                                      |
| `NEXT_PUBLIC_VAPID_PUBLIC_KEY`          | Vercel env + `.env.local` + Vault (`vapid.json`)                    | Browser subscribes to Web Push                         | Manual regen via `npx web-push generate-vapid-keys`                       | **Never unless leaked.** Re-subscribing every client is expensive. |
| `VAPID_PRIVATE_KEY`                     | Vercel env (server-only) + `.env.local` + Vault (`vapid.json`)      | Server signs push payloads                             | Same as above                                                             | Same as above                                                      |
| `RESEND_API_KEY`                        | Vercel env + Vault                                                  | Transactional email                                    | Resend dashboard                                                          | Quarterly                                                          |
| `KIE_AI_API_KEY`                        | `worker/.env` + sourced from `~/.hermes/shared/config/secrets.json` | Image generation (GPT Image 2)                         | Kie.ai dashboard                                                          | Quarterly                                                          |
| `ELEVENLABS_API_KEY`                    | `worker/.env` + sourced from Hermes                                 | Voiceover synthesis                                    | ElevenLabs dashboard → API Keys                                           | Quarterly                                                          |
| `SUBMAGIC_API_KEY`                      | `worker/.env`                                                       | Caption generation                                     | Submagic dashboard                                                        | Quarterly                                                          |
| `HYPERFRAMES_API_KEY`                   | `worker/.env`                                                       | Video composition (b-roll + voiceover)                 | Hyperframes dashboard                                                     | Quarterly (lands in V2)                                            |
| `META_ADS_API_KEY` + `META_AD_ACCOUNTS` | `worker/.env` + sourced from Hermes                                 | Meta Ads performance pulls                             | Meta Business → System Users → Generate Token                             | Quarterly                                                          |
| GHL credentials (`GHL_*`)               | `worker/.env` + `~/.hermes/shared/config/ghl-*.json`                | GoHighLevel pipeline pulls                             | GHL → Settings → Private Integrations                                     | Quarterly                                                          |
| Google Drive OAuth (gog)                | On-disk OAuth state under `~/.config/gog/`                          | Drive mirror uploads                                   | `gog auth login` re-auth                                                  | When expired (typically every few months)                          |
| GitHub PAT (Pedro's)                    | `~/.config/github/token` (chmod 600)                                | API calls for issues/PRs/labels                        | github.com/settings/tokens                                                | Quarterly                                                          |
| Tailscale auth key                      | `worker/.env` + Tailscale admin console                             | Initial `tailscale up` registration (reusable, tagged) | tailscale.com/admin/settings/keys                                         | Quarterly                                                          |
| Anthropic / Claude Code session         | `~/.claude/` (managed by `claude auth login`)                       | Agent runtime                                          | `claude auth login` re-auth                                               | On expiry                                                          |
| Supabase DB password                    | Vault (`supabase.json`)                                             | Direct psql / pooler access (not used in app code)     | Supabase dashboard → Database                                             | On suspected leak                                                  |

### Reference IDs (not secrets, but important)

| Name                                  | Location                                   | What it is                                                                                                 |
| ------------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| Supabase project ref                  | `jfzxlsaywztlytnobgej`                     | The project ID for the live us-east-1 deployment                                                           |
| Supabase region                       | `us-east-1`                                | Matches Vercel's default edge / function region                                                            |
| Meta ad account (shared)              | `act_1209158034034659`                     | Aquarium + Dinero share this; split is encoded in `CAMPAIGN_FILTERS` in the Hermes scripts. Do not change. |
| Drive root folder ID (marketing dept) | Per `MARKETING-DEPT-MAP.md` §9 in upstream | Existing folder tree; reused by the Drive mirror                                                           |
| Tailscale hostname                    | `voxhorizon-worker`                        | MagicDNS name; published via `tag:worker`                                                                  |

---

## Rotation cadence

| Trigger                | Action                                                                                                                                         |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Quarterly review       | Rotate all long-lived API keys (Supabase service role, Resend, Kie, ElevenLabs, Submagic, Meta, GHL, Tailscale, GitHub PAT).                   |
| Suspected leak         | Rotate immediately. Audit `git log` (see below). Rotate any secret with a non-trivial blast radius first (service role, worker shared secret). |
| Vendor rotation prompt | Honor it. Update vault, Vercel env, worker `.env` together.                                                                                    |
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

- **`NEXT_PUBLIC_SUPABASE_ANON_KEY`** ships to the browser. That's fine — Supabase's anon key is gated by RLS server-side. v1 has RLS off (single operator), but the worker / Next.js server is the gate (Tailscale + Vercel Deployment Protection), not the key.
- **`NEXT_PUBLIC_VAPID_PUBLIC_KEY`** is a server-identifier shared with push services. Public by design.
- **Tailscale hostname** (`voxhorizon-worker`) is published via MagicDNS to the tailnet. Not secret.
- **Supabase project URL** (`https://jfzxlsaywztlytnobgej.supabase.co`) is publicly resolvable. Knowing it gets you nothing without a key.
- **Meta ad account IDs** are visible in the Meta Business UI to anyone with access. The API key is the real boundary.
- **Drive folder IDs** are visible in any URL the operator shares. ACLs gate read access; the IDs are just pointers.

---

## On-disk vault layout (Mac)

Recommended structure under `~/.config/voxhorizon/` (chmod 600 on each file):

```
~/.config/voxhorizon/
├── supabase.json    # url, anon, service_role, publishable, db_password
├── vapid.json       # public, private (one-shot generation, never rotates)
├── worker.json      # shared_secret, tailscale_hostname, tailnet
├── resend.json      # api_key, sender_domain
└── README.txt       # plain-text pointer to 1Password for the canonical copy
```

```bash
mkdir -p ~/.config/voxhorizon
chmod 700 ~/.config/voxhorizon
chmod 600 ~/.config/voxhorizon/*.json
```

The vault is **not** an authoritative source for production — Vercel's env-var UI is. The vault exists so a fresh Mac bootstrap (M5 smoke test) doesn't require digging through 1Password mid-recipe.

---

## Quick "I think a secret leaked" runbook

1. **Confirm scope.** Which secret? Where was it exposed (commit, screenshot, log, third-party service)?
2. **Rotate at source.** Supabase / Resend / Kie / etc. dashboards each have a "rotate / revoke" button. Use it.
3. **Update everywhere it's referenced.** Vercel env (production + preview + development), `worker/.env` on the Mac, vault file, 1Password.
4. **Redeploy.** Vercel: trigger a redeploy so new env vars take effect. Worker: restart (`launchctl kickstart -k gui/<uid>/voxhorizon-worker` once M0-22 lands; otherwise `Ctrl+C` and re-run `bash scripts/serve.sh`).
5. **Smoke test.** `curl http://localhost:3000/api/worker/health`; if 401, the new shared secret didn't sync.
6. **Post-mortem.** Write down in a Tracker comment: what leaked, how it leaked, what changed in handling.

---

## VPS production secrets

The worker container runs on a Linux VPS (see VPS-2 / VPS-3). Secrets for the worker process live on disk on the VPS — **not** in the Docker image, **never** in git, and **never** baked into the build.

### Where secrets live on the VPS

```
/opt/voxhorizon/
├── .env          # env file consumed by docker compose
└── docker-compose.yml
```

- **Path:** `/opt/voxhorizon/.env`
- **Owner:** `deploy:deploy`
- **Mode:** `chmod 600` (only the `deploy` user can read or write)
- **Template:** `worker/.env.example` in this repo is the single source of truth for the list of required keys. Run `worker/scripts/check-env.sh` at container start to fail fast on any missing var.
- **Build invariant:** the Dockerfile (VPS-2) does **not** copy any `.env*` file into the image. `docker compose up` mounts `/opt/voxhorizon/.env` as `env_file:` so secrets are runtime-only.
- **Git invariant:** `.gitignore` blocks every `.env*` pattern except `.env.example`. There is zero overlap between the secret values and any tracked file.

### Full secret inventory (VPS scope)

Same grouping as `worker/.env.example`. For each entry: var name, what it does for the worker, where to rotate it.

#### Identity

| Var                      | Purpose                                                                                                                     | Rotate at                                                                                                                                |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `WORKER_SHARED_SECRET`   | Bearer token compared (constant-time) on every request from Vercel to the worker. **Shared with Vercel env.**               | Regenerate locally: `python -c "import secrets; print(secrets.token_hex(64))"`. Apply to **both** Vercel env and `/opt/voxhorizon/.env`. |
| `WORKER_PUBLIC_BASE_URL` | The URL the Next.js app uses to reach this worker (also used in signed b-roll URLs). Not secret, but environment-dependent. | Change if the VPS domain / Tailscale Funnel URL changes.                                                                                 |
| `WORKER_CORS_ORIGIN`     | CORS allow-origin for the Next.js app. Not secret.                                                                          | Change if the Vercel production URL changes.                                                                                             |
| `WORKER_VERSION`         | Build / image tag surfaced on `/health`. Not secret.                                                                        | Updated by the deploy pipeline.                                                                                                          |

#### Supabase

| Var                         | Purpose                                                             | Rotate at                                                                                                                   |
| --------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `SUPABASE_URL`              | Project endpoint. Public.                                           | Supabase dashboard → Project Settings → API. URL itself is stable.                                                          |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role JWT (bypasses RLS). **Shared with Vercel server env.** | Supabase dashboard → Project Settings → API → Rotate service_role. Apply to **both** Vercel env and `/opt/voxhorizon/.env`. |

#### Storage

| Var                   | Purpose                                                | Rotate at                    |
| --------------------- | ------------------------------------------------------ | ---------------------------- |
| `BROLL_STORE_BACKEND` | `local` or `supabase`. Not secret.                     | Edit `/opt/voxhorizon/.env`. |
| `BROLL_LOCAL_ROOT`    | Filesystem path for the local b-roll pool. Not secret. | Edit `/opt/voxhorizon/.env`. |

#### Integrations: image

| Var              | Purpose                                | Rotate at                    |
| ---------------- | -------------------------------------- | ---------------------------- |
| `KIE_AI_API_KEY` | Kie.ai (GPT Image 2) image generation. | Kie.ai dashboard → API Keys. |

#### Integrations: video

| Var                  | Purpose              | Rotate at                                  |
| -------------------- | -------------------- | ------------------------------------------ |
| `ELEVENLABS_API_KEY` | Voiceover synthesis. | ElevenLabs dashboard → Profile → API Keys. |
| `SUBMAGIC_API_KEY`   | Caption generation.  | Submagic dashboard → Settings → API.       |

#### Audit data sources

| Var                | Purpose                               | Rotate at                                      |
| ------------------ | ------------------------------------- | ---------------------------------------------- |
| `META_ADS_API_KEY` | Meta Ads performance pulls.           | Meta Business → System Users → Generate Token. |
| `GHL_API_KEY`      | GoHighLevel pipeline / contact pulls. | GHL → Settings → Private Integrations.         |

#### Notifications

| Var                 | Purpose                                                                                   | Rotate at                                                                             |
| ------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `VAPID_PRIVATE_KEY` | Server signs Web Push payloads. **Paired with `NEXT_PUBLIC_VAPID_PUBLIC_KEY` on Vercel.** | `npx web-push generate-vapid-keys`. **Do not rotate on a schedule** — see note below. |

#### Agent runtime

| Var                 | Purpose                                           | Rotate at                         |
| ------------------- | ------------------------------------------------- | --------------------------------- |
| `ANTHROPIC_API_KEY` | Claude Code runner (server-side agent execution). | console.anthropic.com → API Keys. |

#### Monitoring

| Var                  | Purpose                                                     | Rotate at                    |
| -------------------- | ----------------------------------------------------------- | ---------------------------- |
| `TAILSCALE_HOSTNAME` | MagicDNS hostname surfaced for log correlation. Not secret. | Edit `/opt/voxhorizon/.env`. |

#### Reverse proxy (VPS-3)

| Var                      | Purpose                                                                                   | Rotate at                    |
| ------------------------ | ----------------------------------------------------------------------------------------- | ---------------------------- |
| `VOXHORIZON_WORKER_HOST` | Hostname Caddy obtains a Let's Encrypt cert for and matches in its Caddyfile. Not secret. | Edit `/opt/voxhorizon/.env`. |

##### Cloudflare DNS setup (operator)

There is no Cloudflare credential to manage for v1 — Caddy speaks ACME directly to Let's Encrypt — but the operator's one-time Cloudflare wiring is recorded here so the dependency is auditable.

- **DNS.** Create an A record `worker.voxhorizon.com` → VPS public IP. Proxy status: **ON** (orange cloud). Cloudflare's edge fronts the user-facing TLS leg.
- **SSL/TLS mode.** Cloudflare dashboard → SSL/TLS → Overview → **Full (strict)**. Cloudflare validates the upstream Let's Encrypt cert that Caddy presents. _Flexible_ would terminate TLS at the edge and talk plaintext to Caddy — never use it. _Full_ (non-strict) would accept any cert from the origin including self-signed — avoid; Let's Encrypt makes strict trivial.
- **No API token required.** Cloudflare API tokens would only be needed if v2 moves to DNS-01 ACME challenges (e.g. for wildcard certs). v1 uses HTTP-01 over the Cloudflare edge, which works out of the box once the proxy is ON and SSL mode is Full (strict).
- **Cert renewal.** Caddy renews ~30 days before expiry. State persists in the `voxhorizon-caddy-data` named volume across container restarts.

### VAPID note

`VAPID_PRIVATE_KEY` (and its public counterpart `NEXT_PUBLIC_VAPID_PUBLIC_KEY` on Vercel) is **never rotated on a schedule.** The keypair identifies the push origin to every browser that has subscribed. Rotating the private key forces **every subscriber** to re-subscribe — the old push endpoint becomes unusable for the existing subscription records in `push_subscriptions`. Only rotate on confirmed leak, and only after planning the re-subscribe migration (clear `push_subscriptions`, prompt every active client to re-permission Web Push).

### Quarterly rotation checklist

Run the first weekend of each quarter. Tick each box as you go.

- [ ] **Supabase service role.** Rotate at Supabase dashboard; update Vercel env (production + preview + development) **and** `/opt/voxhorizon/.env`. Use the rolling pattern (below) so neither side breaks during the swap.
- [ ] **`WORKER_SHARED_SECRET`.** Regenerate (`python -c "import secrets; print(secrets.token_hex(64))"`); update Vercel env **and** `/opt/voxhorizon/.env`. Rolling pattern applies.
- [ ] **Kie.ai (`KIE_AI_API_KEY`).** Rotate at kie.ai; update `/opt/voxhorizon/.env`; `docker compose up -d worker`.
- [ ] **ElevenLabs (`ELEVENLABS_API_KEY`).** Rotate at elevenlabs.io; update `/opt/voxhorizon/.env`; restart worker.
- [ ] **Submagic (`SUBMAGIC_API_KEY`).** Rotate at submagic.co; update `/opt/voxhorizon/.env`; restart worker.
- [ ] **Meta Ads (`META_ADS_API_KEY`).** Generate fresh System User token; update `/opt/voxhorizon/.env`; restart worker.
- [ ] **GoHighLevel (`GHL_API_KEY`).** Rotate at GHL → Settings → Private Integrations; update `/opt/voxhorizon/.env`; restart worker.
- [ ] **Anthropic (`ANTHROPIC_API_KEY`).** Rotate at console.anthropic.com; update `/opt/voxhorizon/.env`; restart worker.
- [ ] **Resend (`RESEND_API_KEY`).** Vercel-side only — update Vercel env; redeploy. (Not consumed by the worker.)
- [ ] **GitHub PAT (Pedro's).** Rotate at github.com/settings/tokens; update `~/.config/github/token` (chmod 600) on the dev box.
- [ ] **Tailscale auth key.** Rotate at tailscale.com/admin/settings/keys; update `/opt/voxhorizon/.env` if the worker re-registers via auth key on boot.
- [ ] **VAPID.** Skip unless leaked — see VAPID note above.
- [ ] **Audit.** Run the `git log -S` greps under [Auditing](#auditing) to confirm nothing leaked into history during the quarter.
- [ ] **Smoke test.** `curl https://<vps-domain>/health` → 200; `curl https://<vercel-app>/api/worker/health` → 200; trigger one end-to-end creative generation to confirm Kie + ElevenLabs + Submagic + Supabase paths all wired.

### Per-secret rotation procedure

The default flow for any worker-only secret (one that lives in `/opt/voxhorizon/.env` and nowhere else):

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

4. **Restart the worker** to pick up the new env:

   ```bash
   docker compose up -d worker
   docker compose logs --tail=50 worker   # confirm check-env.sh prints "env OK"
   ```

5. **Smoke test.** `curl https://<vps-domain>/health` should return `200` with the expected `WORKER_VERSION` and `build_sha`. For provider-specific keys, trigger one operation that exercises that integration (e.g. a small Kie generation for `KIE_AI_API_KEY`).
6. **Revoke the old value** at the provider dashboard once the smoke passes.

#### Shared secrets — rolling swap (no-downtime)

Two secrets are read by **both** Vercel (Next.js) and the VPS worker:

- `WORKER_SHARED_SECRET` — the bearer the app sends to the worker.
- `SUPABASE_SERVICE_ROLE_KEY` — the admin key both sides use to talk to Postgres.

A naive "rotate everywhere at once" causes a ~minute of 401s while Vercel redeploys race the worker restart. Use a rolling pattern instead:

1. **Generate the new value.** For `WORKER_SHARED_SECRET`, regen locally. For Supabase service role, rotate at Supabase dashboard but **do not** invalidate the old key yet (Supabase issues the new key alongside the old until you confirm).
2. **Vercel: add the new value alongside the old as a parallel env var.**
   - Add `WORKER_SHARED_SECRET_NEXT` (or `SUPABASE_SERVICE_ROLE_KEY_NEXT`) in Vercel's env-var UI for production + preview + development.
   - Trigger a Vercel deploy. After it ships, both the old `WORKER_SHARED_SECRET` and the new `WORKER_SHARED_SECRET_NEXT` are present in the Vercel runtime; **app code still reads the old one.**
3. **VPS: update `/opt/voxhorizon/.env` to the new value.**

   ```bash
   ssh deploy@<vps-host>
   sudo -u deploy ${EDITOR:-nano} /opt/voxhorizon/.env   # set WORKER_SHARED_SECRET=<new>
   docker compose up -d worker
   ```

   The worker now accepts the new value. The Vercel app still sends the **old** value (held in `WORKER_SHARED_SECRET`), so requests start failing — this is the moment of cutover. Keep this window short (under a minute).

4. **Vercel: swap the active var.**
   - Edit `WORKER_SHARED_SECRET` in Vercel's env UI: set it to the new value (same value as `WORKER_SHARED_SECRET_NEXT`).
   - Trigger a Vercel deploy. Once it ships, Vercel sends the new value, the worker accepts it, traffic is restored.
5. **Verify.** `curl https://<vercel-app>/api/worker/health` → 200. Watch worker logs for 401s.
6. **Clean up.**
   - Remove `WORKER_SHARED_SECRET_NEXT` from Vercel env (no longer needed).
   - At the provider (Supabase), invalidate the old service-role JWT.

The same pattern applies to `SUPABASE_SERVICE_ROLE_KEY`: stage `SUPABASE_SERVICE_ROLE_KEY_NEXT` in Vercel first, then update the VPS .env, then promote the new value into the active var on Vercel, then remove the staging var and invalidate the old key.

> **Order matters.** Always: **stage on Vercel → update VPS → promote on Vercel → remove staging → invalidate at provider.** Going the other direction (VPS first with no Vercel staging) creates a guaranteed downtime window because Vercel keeps the old value in the running deployment until the next push.

### v2 upgrade path: `sops + age`

When the operator count goes above one — or when audit / compliance demands it — migrate to [`sops`](https://github.com/getsops/sops) with [`age`](https://github.com/FiloSottile/age) recipients for git-committed encrypted secrets:

- `.env` files are encrypted in place; the ciphertext is committed to the repo.
- Each operator has an `age` keypair; the public keys are listed in `.sops.yaml`.
- Decryption on the VPS happens at `docker compose up` via `sops exec-env` or a small entrypoint shim — no plaintext on disk longer than the process lifetime.
- Rotation becomes a `sops updatekeys` operation; new operators are onboarded by adding their public key and re-encrypting.

This is **not** v1 scope. v1's single-operator threat model is met by `chmod 600 /opt/voxhorizon/.env` + tight SSH ACLs. Revisit when (a) a second operator needs commit-level access, or (b) the worker fleet grows past one VPS and provisioning needs a shared, auditable source for the env file.

---

## GitHub Actions deploy secrets

The `deploy-worker` workflow (`.github/workflows/deploy-worker.yml`, lands in VPS-4) builds the worker image on each push to `main`, pushes to GHCR, then SSHes into the VPS as the `deploy` user to roll the compose stack. The workflow needs three repo-level secrets to do its job. Configure them at **Settings → Secrets and variables → Actions → New repository secret**.

| Secret        | Purpose                                                                                                                 | How to populate                                                                                                                                                                         |
| ------------- | ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VPS_HOST`    | The DNS name or IP the workflow `ssh`s into. Not secret per se, but treat it as one so it's not in git.                 | Production hostname (e.g. `worker.voxhorizon.app`) or the bare VPS IP if DNS isn't wired yet. Match whatever resolves to the box.                                                       |
| `VPS_USER`    | The unprivileged Linux user the deploy script runs as. Must be in the `docker` group and own `/opt/voxhorizon`.         | Set to `deploy`. Provisioned by `infra/deploy/setup-deploy-user.sh` on a fresh VPS.                                                                                                     |
| `VPS_SSH_KEY` | The **private** half of a deploy-only SSH keypair. Used to authenticate the GitHub Actions runner into `deploy@<host>`. | Generate fresh: `ssh-keygen -t ed25519 -f ~/.ssh/voxhorizon_deploy -C "github-actions-deploy"`. Paste the **contents** of `~/.ssh/voxhorizon_deploy` (private key, with header/footer). |

### Key handling — non-negotiables

- **Fresh ed25519 keypair, deploy-only.** Do **not** reuse Pedro's admin key, an existing personal key, or a Mac-host key. The deploy key is a single-purpose credential whose blast radius is "rollout the worker on this one VPS." Compromise of this key must not give shell access anywhere else.
- **No passphrase.** GitHub Actions can't type one. The key's protection is its scope (deploy-only) + the `from=` and `command=` restrictions on the authorized_keys line.
- **Private key in GHA secret only.** Never commit it. Never paste it into Vercel env, the vault, or 1Password unless you also accept the rotation policy: rotating the GHA secret means rotating every other copy.
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

| Service              | Account                          | Dashboard                   | API key needed? | Notes                                                                                                                                    |
| -------------------- | -------------------------------- | --------------------------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Uptime Robot         | `diogosilvaenterprise@gmail.com` | https://uptimerobot.com     | No (free tier)  | Polls `https://worker.<domain>/work/ping` every 5 min. See [`infra/monitoring/README.md`](./infra/monitoring/README.md) for setup.       |
| Healthchecks.io      | `diogosilvaenterprise@gmail.com` | https://healthchecks.io     | No              | One check per scheduled job. Ping URLs are per-check (treat like secrets — anyone with one can fake a heartbeat). Store on the VPS only. |
| Supabase status page | (public, no account)             | https://status.supabase.com | No              | Email subscription added for `diogosilvaenterprise@gmail.com`; also mirrored in Uptime Robot as an independent monitor.                  |

The Healthchecks.io ping URLs are the only monitoring-related thing that needs handling — they live on the VPS inside the systemd unit files / wrapper scripts (lands with #59). Treat them like service credentials: don't commit them to git, copy them out of the Healthchecks dashboard at provisioning time.

See [`infra/monitoring/README.md`](./infra/monitoring/README.md) for the full setup runbook and alert response procedure.
