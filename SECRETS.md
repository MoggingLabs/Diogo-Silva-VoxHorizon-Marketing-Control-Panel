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
