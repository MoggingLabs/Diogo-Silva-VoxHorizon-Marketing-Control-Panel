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
 */
export default defineConfig({
  testDir: "./tests/e2e",
  // Single shared DB — serialize to avoid races on the test client's briefs.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? "list" : "html",
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "pnpm dev",
    url: "http://localhost:3000",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
