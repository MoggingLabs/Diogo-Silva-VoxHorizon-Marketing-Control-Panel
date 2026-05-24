# Setup

> **Status / current stack (2026-05-24).** This from-zero recipe is stale. It
> describes an older Mac / Tailscale / Vercel / Claude-Code bootstrap. The live
> system runs on a single Hostinger VPS: Next.js 15 + Supabase + a Python
> FastAPI worker + a Hermes operator agent, fronted by Caddy. Treat the steps
> below as historical until this guide is rewritten for the VPS. For the
> current architecture and the rebuild in progress, see
> [`PIPELINE-REBUILD-ARCHITECTURE.md`](./PIPELINE-REBUILD-ARCHITECTURE.md) and
> the decision records in [`docs/adr`](./docs/adr).

From-zero recipe for bootstrapping the VoxHorizon Marketing Control Panel on a fresh Mac. Follow top to bottom — every step is idempotent unless noted.

Target machine: Diogo's Mac (Apple Silicon, macOS Sonoma+). The Linux path is identical except for `brew` substitutions.

> Companion docs: [`README.md`](./README.md) for the bird's-eye view, [`SECRETS.md`](./SECRETS.md) for credential storage, [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the locked spec.

---

## 1. Prereqs

Install once. Versions are minimums.

| Tool              | Version | Install                                                                        |
| ----------------- | ------- | ------------------------------------------------------------------------------ |
| Node.js           | 20 LTS  | `brew install node@20` then `brew link node@20`                                |
| pnpm              | 9.15+   | `corepack enable` then `corepack prepare pnpm@9.15.0 --activate`               |
| Python            | 3.11+   | `brew install python@3.11`                                                     |
| uv                | Latest  | `curl -LsSf https://astral.sh/uv/install.sh \| sh`                             |
| Supabase CLI      | 1.200+  | `brew install supabase/tap/supabase`                                           |
| Tailscale         | Latest  | Download from [tailscale.com/download/mac](https://tailscale.com/download/mac) |
| Claude Code       | Latest  | `npm i -g @anthropic-ai/claude-code` then `claude auth login`                  |
| `gog` CLI         | Latest  | Per the Hermes-era install (Diogo already has this configured)                 |
| GitHub CLI / curl | Either  | `brew install gh` (optional; we use raw curl + PAT)                            |

Sanity:

```bash
node --version       # v20.x or higher
pnpm --version       # 9.15+
python3 --version    # 3.11+
uv --version
supabase --version
tailscale version
claude --version
```

---

## 2. External accounts

These are one-time. Mark them off in the project secrets vault as they're created (see [`SECRETS.md`](./SECRETS.md)).

- **Supabase** — org: `VoxHorizon`. The project for this build is already provisioned as **`jfzxlsaywztlytnobgej`** in **us-east-1** (see issue M0-1 in the tracker). Anon key, service role key, and publishable key are captured in the vault.
- **Vercel** — team: `Diogo's Projects`. The project links this repo and auto-deploys `main` → production. Pro plan required for Deployment Protection (the UI auth gate, see M0-15).
- **Tailscale** — Diogo's tailnet. The Mac is tagged `tag:worker`. Funnel is enabled so Vercel can reach `https://<hostname>.<tailnet>.ts.net`.
- **Resend** — sender domain decided in M0-7. API key scoped "send-only".
- **Kie.ai** — Diogo's existing account (predates this build). Key reused from the Hermes config.
- **ElevenLabs** — Diogo's existing account. Key reused from the Hermes config.
- **Submagic** — required for video captioning. API key in `worker/.env` only.
- **Meta Business** — ad accounts + API key. Existing Hermes config carries `act_1209158034034659` shared between Aquarium / Dinero — do not change the `CAMPAIGN_FILTERS` split.
- **Google (Drive)** — `diogo@voxhorizon.com`. `gog` CLI holds the OAuth state on disk; re-auth when expired.

---

## 3. Clone + install

```bash
mkdir -p ~/github && cd ~/github
git clone git@github.com:pveloso01/Diogo-Silva-VoxHorizon-Marketing-Control-Panel.git
cd Diogo-Silva-VoxHorizon-Marketing-Control-Panel
pnpm install
cd worker && uv sync --extra dev && cd ..
```

This installs both halves: the Next.js dependencies at the root, and the Python worker dependencies (including dev extras: `pytest`, `pytest-asyncio`) inside `worker/`. Husky's `prepare` hook runs automatically — pre-commit lint/format is now wired.

---

## 4. Env file setup

Two env files, one per half. **Both are gitignored.** Only the `.env.example` templates live in the repo.

```bash
cp .env.example .env.local
cp worker/.env.example worker/.env
```

Fill in values from the vault. Key references:

### `.env.local` (Next.js)

| Var                             | Source                                                                     | Notes                                                |
| ------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------- |
| `NEXT_PUBLIC_SUPABASE_URL`      | Supabase Dashboard → Project Settings → API                                | `https://jfzxlsaywztlytnobgej.supabase.co`           |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Same dashboard                                                             | Public; safe in browser                              |
| `SUPABASE_SECRET_KEY`           | Same dashboard, "Publishable and Secret API Keys" → Secret (`sb_secret_*`) | **SECRET** — server-only, bypasses RLS               |
| `WORKER_URL`                    | Tailscale Funnel URL for the Mac                                           | e.g. `https://voxhorizon-worker.<tailnet>.ts.net`    |
| `WORKER_SHARED_SECRET`          | Generated in step 6                                                        | Match `worker/.env`                                  |
| `TAILSCALE_ONLY`                | Off by default                                                             | Set to `1` (log) or `strict` (403) in production     |
| `TAILSCALE_CIDRS`               | Default `100.64.0.0/10`                                                    | Override only if your tailnet uses a different range |
| `RESEND_API_KEY`                | Resend dashboard                                                           | Lands in M4                                          |
| `NEXT_PUBLIC_VAPID_PUBLIC_KEY`  | Generated in M0-8                                                          | Public, ships to browser                             |
| `VAPID_PRIVATE_KEY`             | Generated in M0-8                                                          | **SECRET** — server-only                             |

### `worker/.env` (FastAPI)

| Var                      | Source                                        | Notes                                |
| ------------------------ | --------------------------------------------- | ------------------------------------ |
| `WORKER_SHARED_SECRET`   | Match `.env.local`                            | 64-byte hex                          |
| `WORKER_PUBLIC_BASE_URL` | Funnel URL or `http://localhost:8000` for dev |                                      |
| `WORKER_CORS_ORIGIN`     | Next.js origin                                | `http://localhost:3000` for dev      |
| `SUPABASE_URL`           | Same as `.env.local`                          |                                      |
| `SUPABASE_SECRET_KEY`    | Same as `.env.local`                          | Bypasses RLS; worker uses for writes |
| `KIE_AI_API_KEY`         | Hermes config                                 | Image generation                     |
| `ELEVENLABS_API_KEY`     | Hermes config                                 | Voiceover                            |
| `SUBMAGIC_API_KEY`       | Submagic dashboard                            | Captions                             |
| `META_ADS_API_KEY`       | Hermes config                                 | Performance pulls (lands in M4)      |
| `BROLL_STORE_BACKEND`    | `local` (default)                             | Switch to `supabase` later           |
| `BROLL_LOCAL_ROOT`       | `~/voxhorizon-worker/storage/broll-pool`      | Local b-roll pool                    |
| `TAILSCALE_HOSTNAME`     | `voxhorizon-worker`                           | Used in `/work/health` payload       |

Both halves trim whitespace via `cleanEnv()` (Next.js) and a pydantic validator (worker), so stray `\n` from dashboard copy-paste won't blow up at runtime.

---

## 5. Apply database schema

The schema lives in `db/migrations/`. Three migrations exist as of M0:

- `0001_initial_schema.sql` — clients, briefs, creatives, video_briefs, video_creatives, iterations, copy variants, launch packages, perf tables, events, overrides, sync_log, push_subscriptions, enums, helper functions
- `0002_realtime_publication.sql` — adds tables to `supabase_realtime` publication
- `0003_storage_buckets.sql` — provisions the `creatives` bucket (50 MiB, image/video/audio MIME)

They're **already applied** to the live project (`jfzxlsaywztlytnobgej`). The push is idempotent and useful when bringing up a Supabase branch or local stack.

```bash
supabase login                                       # one-time
supabase link --project-ref jfzxlsaywztlytnobgej     # one-time
supabase db push                                     # idempotent
```

Verify:

```bash
supabase migration list                              # all three listed as applied
```

See [`db/SCHEMA.md`](./db/SCHEMA.md) for the table-by-table reference.

---

## 6. Worker shared secret + Tailscale Funnel

Generate a fresh 64-byte hex secret. Match it on both sides.

```bash
python3 -c "import secrets; print(secrets.token_hex(64))"
```

Put the same value in `.env.local` (`WORKER_SHARED_SECRET`) and `worker/.env` (`WORKER_SHARED_SECRET`). Add it to the Vercel project's env vars (production + preview + development) via the dashboard.

Bring up Tailscale Funnel on the Mac:

```bash
sudo tailscale up --advertise-tags=tag:worker
tailscale funnel 8000                                # exposes :8000 over HTTPS
```

The Funnel URL is what goes into `WORKER_URL` on the Vercel side.

---

## 7. Regenerate Supabase types

After any schema change:

```bash
pnpm regen:types
```

Wraps `supabase gen types typescript --linked > lib/supabase/types.gen.ts`. Commit the regenerated file.

---

## 8. Start dev

Two terminals.

```bash
# terminal 1 — Next.js
pnpm dev
# Next.js on http://localhost:3000
```

```bash
# terminal 2 — worker
cd worker
bash scripts/serve.sh
# FastAPI on http://localhost:8000 (uvicorn reload on)
```

Smoke test:

```bash
curl -sH "Authorization: Bearer $(grep ^WORKER_SHARED_SECRET worker/.env | cut -d= -f2)" \
  http://localhost:8000/work/health | jq
```

And the proxy:

```bash
curl http://localhost:3000/api/worker/health | jq
```

Both should return `{ "ok": true, ... }`.

---

## 9. Run checks

### TypeScript + ESLint

```bash
pnpm tsc --noEmit                                    # type check
pnpm lint                                            # ESLint flat config
pnpm format:check                                    # Prettier
```

### Python (worker)

```bash
cd worker
uv run pytest
```

Both must pass before opening a PR. Husky pre-commit already runs lint-staged on JS/TS/CSS/Markdown files — Python isn't part of pre-commit (yet).

---

## 10. Deploy

**Next.js (Vercel).** Automatic on push to `main`. Preview deploys fire on PRs. Configure via the Vercel dashboard — env vars there are the source of truth for production. Deployment Protection is the auth gate; only members of Diogo's Vercel team can hit the production URL without an SSO challenge (per M0-15 decision, locked in `ARCHITECTURE.md`).

**Worker (Mac).** Stays local. Started via `bash scripts/serve.sh` in development; M0-22 lands a launchd plist + Tailscale Funnel ACL for production-grade persistence. There is no cloud deployment for the worker in v1.

Pre-deploy checklist (M5):

- [ ] All env vars set in Vercel (production + preview)
- [ ] Worker autostart configured on the Mac
- [ ] Tailscale Funnel reachable from a non-tailnet device through the Funnel URL
- [ ] `pnpm tsc --noEmit && pnpm lint && pnpm build` all green locally
- [ ] Smoke: `/api/worker/health` returns `ok: true` from the production URL

---

## 11. Troubleshooting

**Husky doesn't run on commit.** `pnpm prepare` to re-install hooks. If you're inside a worktree, hooks are inherited from the main checkout — running `pnpm prepare` in either spot is enough.

**ESLint complains about unsupported flat config.** We're on ESLint 9 + flat config (`eslint.config.mjs`). If your editor's ESLint plugin is older, upgrade or set `eslint.useFlatConfig = true` in workspace settings.

**`supabase db push` errors with `IMMUTABLE expressions`.** The `0001_initial_schema.sql` migration's daily-uniqueness index uses a `date_trunc()` in an expression index that needs an IMMUTABLE wrapper. PR #127 lands the fix — if you hit it on a fresh branch, pull main.

**`fetch failed` from Next.js to the worker.** Probably the Funnel URL has a trailing newline in `.env.local`. `cleanEnv()` strips it now, but if you see the error, double-check the value with `cat -A .env.local`.

**Worker returns 401 on every route.** The Bearer token in `.env.local` doesn't match `worker/.env`. Regenerate with `python -c "import secrets; print(secrets.token_hex(64))"` and update both.

**Claude Code auth expired.** Run `claude auth login` again. Tokens live under `~/.claude/`.

**`gog` returns expired token errors.** Re-auth: `gog auth login` (per the existing Hermes flow). The OAuth state is on disk under `~/.config/gog/`.

**Realtime channel returns no events on insert.** Check `select schemaname, tablename from pg_publication_tables where pubname = 'supabase_realtime'` — only the tables in `0002_realtime_publication.sql` get events. `events` and `sync_log` are intentionally excluded.

**`pnpm install` fails on a transient registry timeout.** `pnpm install --no-frozen-lockfile` once, then commit the regenerated lockfile only if it's intentional.
