import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config for VoxHorizon e2e tests.
 *
 * V1 strategy: tests hit the dev Supabase project directly using a dedicated
 * `test-e2e-client` row. Single-worker + non-parallel keeps DB state predictable
 * — each spec creates and tears down its own briefs. A dedicated test schema
 * lands later (see M5-7 / #70).
 *
 * The dev server is auto-spawned via `webServer`; in CI we reuse an existing
 * server when one is already running.
 *
 * When `PLAYWRIGHT_BASE_URL` is set explicitly (the CI e2e job pre-starts a
 * production `pnpm start` server + the Python worker before invoking Playwright),
 * we DON'T auto-spawn a `webServer` — letting Playwright spawn `pnpm dev` would
 * fight the already-running server for port 3000. Locally (no
 * PLAYWRIGHT_BASE_URL) we auto-spawn `pnpm dev` as before.
 */
const usesExternalServer = !!process.env.PLAYWRIGHT_BASE_URL;

export default defineConfig({
  testDir: "./tests/e2e",
  // Single shared DB — serialize to avoid races on the test client's briefs.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? "list" : "html",
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  // Omit the auto-spawned dev server when an external server URL is provided.
  ...(usesExternalServer
    ? {}
    : {
        webServer: {
          command: "pnpm dev",
          url: "http://localhost:3000",
          reuseExistingServer: !process.env.CI,
          timeout: 120_000,
        },
      }),
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
