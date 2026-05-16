# Tests

Playwright end-to-end suite for the VoxHorizon Marketing Control Panel.

## Layout

- `tests/e2e/` — Playwright specs.
  - `_fixtures.ts` — Supabase admin-client helpers + the shared `test`
    fixture that upserts a known `test-e2e-client` row and cleans up briefs
    between runs.
  - `brief-lifecycle.spec.ts` — image-brief lifecycle (M1-10 / #28).
  - `video-brief-lifecycle.spec.ts` — video-brief lifecycle (V1-10 / #87).
- `playwright.config.ts` (repo root) — Chromium-only, single worker, dev
  server auto-spawned via `webServer.command = "pnpm dev"`.

## Strategy (v1)

The dev Supabase project is also the test target. To stay isolated from real
client data the suite:

1. Upserts a dedicated `clients` row with slug `test-e2e-client`.
2. Wipes that client's `briefs` + `video_briefs` rows before AND after each
   test (FK cascades take care of children — creatives, iterations, events).
3. Runs serially (`workers: 1`, `fullyParallel: false`) so two tests don't
   race over the same client's brief rows.

A dedicated test schema lands later (see M5-7 / #70). At that point the
admin-client wiring in `_fixtures.ts` swaps to a different `NEXT_PUBLIC_SUPABASE_URL`
and the same specs still pass.

## Running locally

Prereqs:

- `pnpm install` (the workspace already lists `@playwright/test`).
- Chromium browser binary — prebuilt under `~/.cache/ms-playwright` by the
  worker bootstrap script. Reinstall manually with `pnpm test:e2e:install`.
- `.env.local` populated with at minimum:
  - `NEXT_PUBLIC_SUPABASE_URL`
  - `NEXT_PUBLIC_SUPABASE_ANON_KEY` (used by the browser flows the tests
    drive)
  - `SUPABASE_SERVICE_ROLE_KEY` (consumed by `_fixtures.ts`)

Then:

```bash
pnpm test:e2e         # headless, reporter=html in dev, list in CI
pnpm test:e2e:ui      # Playwright UI mode — interactive runner
```

The config auto-starts `pnpm dev` on `http://localhost:3000` if no server is
already listening on that port; pass `PLAYWRIGHT_BASE_URL=...` to target a
different origin.

## Caveats

- The runner picks up env vars from the shell, not `.env.local` directly.
  Either export the vars before running, source `.env.local`
  (`set -a && . .env.local && set +a`), or run via `dotenv-cli`.
- The fixture throws a friendly error if `SUPABASE_SERVICE_ROLE_KEY` is
  missing so it fails fast rather than spinning on a non-deterministic
  network error.
