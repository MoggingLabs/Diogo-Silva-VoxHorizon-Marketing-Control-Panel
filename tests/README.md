# Tests

Playwright end-to-end suite for the VoxHorizon Marketing Control Panel.

## Layout

- `tests/e2e/` — Playwright specs.
  - `_fixtures.ts` — Supabase admin-client helpers + the shared `test`
    fixture that upserts a known `test-e2e-client` row and cleans up
    briefs / creatives / launches / `campaign_perf_*` between runs.
  - `_seed.ts` — direct-insert seeders for downstream specs that don't
    want to depend on the worker being up (creatives, launches, perf rows).
  - `brief-lifecycle.spec.ts` — image-brief lifecycle (M1-10 / #28).
  - `video-brief-lifecycle.spec.ts` — video-brief lifecycle (V1-10 / #87).
  - `image-creative-loop.spec.ts` — image variants grid + side panel +
    decision API (M2-15 / #43).
  - `video-creative-loop.spec.ts` — video variants grid + side panel +
    decision API + script outline rendering (V2-19 / #106).
  - `launch-image.spec.ts` — `/launches/[id]` approval gate + builder API
    pre-flight (M3-8 / #51).
  - `launch-video.spec.ts` — `/launches/video/[id]` approval gate + builder
    API pre-flight (V3-8 / #114).
  - `audit.spec.ts` — `/audit` cards / table / format tab / window picker
    against seeded `campaign_perf_*` rows (M4-12 / #63).
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

## Running the Wave 5 specs

The Wave 5 specs (`image-creative-loop`, `video-creative-loop`,
`launch-image`, `launch-video`, `audit`) plug into the same `test` fixture
as the brief-lifecycle specs — same setup, same teardown. To run just the
Wave 5 suite:

```bash
pnpm exec playwright test tests/e2e/image-creative-loop.spec.ts
pnpm exec playwright test tests/e2e/video-creative-loop.spec.ts
pnpm exec playwright test tests/e2e/launch-image.spec.ts
pnpm exec playwright test tests/e2e/launch-video.spec.ts
pnpm exec playwright test tests/e2e/audit.spec.ts
```

Strategy notes:

- All seeding goes through `_seed.ts` (admin client / RLS bypass). The
  worker is NOT required to be running — image-creative tiles fall back
  to the "No render yet" placeholder when `file_path_supabase` is null,
  and the video tiles fall back to the Clapperboard placeholder when the
  captioned MP4 path is null. Tests drive the UI and API directly.
- The `clientId` fixture wipes the test client's briefs, creatives,
  launch packages, and `campaign_perf_*` rows before AND after each test.
  That's the only way Wave 5 specs avoid cross-test pollution — the dev
  DB is shared.
- `audit.spec.ts` seeds rows with `campaign_id` values prefixed by
  `test-` so leftover rows from a failed run are spottable in the
  dashboard. Cleanup also drops these by `client_id`.

## Caveat — server logs in the launch failure path

`launch-image.spec.ts` / `launch-video.spec.ts` include a pre-flight
failure test that POSTs to `/api/launches` with a missing copy variant.
The Next.js dev server logs a "worker unavailable" warning when the
upstream Hyperframes worker isn't running — that's expected; the route
gracefully degrades to a preflight-only verdict and still returns 422.
