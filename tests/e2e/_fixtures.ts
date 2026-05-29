import { test as base, expect } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/types.gen";

import { seedSessionCookie } from "./_auth";

import {
  cleanupCampaignPerf,
  cleanupCreatives,
  cleanupLaunchPackages,
  cleanupPipelines,
  seedApprovedBrief,
  seedCampaignPerf,
  seedCreative,
  seedPipeline,
  seedPushedLaunch,
  seedVideoCreative,
  type BriefFormat,
  type SeedCampaignPerfRow,
  type SeedCreativeOpts,
  type SeedPipelineOpts,
  type SeedVideoCreativeOpts,
} from "./_seed";

/**
 * Shared e2e test fixtures.
 *
 * Strategy:
 *  - Use the Supabase service-role client to upsert a known `test-e2e-client`
 *    row before each test and wipe its briefs (image + video) before/after the
 *    test body. This isolates runs even though we share the dev DB with real
 *    data — the `test-` prefixed slug acts as the tenant boundary.
 *  - Service-role bypasses RLS, which is what we want here: the harness needs
 *    god-mode to set up and tear down state cleanly.
 *
 * Env vars:
 *  - `NEXT_PUBLIC_SUPABASE_URL`     — required.
 *  - `SUPABASE_SECRET_KEY`    — required. Read from `.env.local` (Next.js
 *    autoloads `.env.local` for the dev server; the test runner reads it from
 *    `process.env` after Playwright spawns the dev server, so callers may need
 *    to source these into the runner's env explicitly).
 *  - `PLAYWRIGHT_BASE_URL`          — optional, defaults to localhost:3000 (see
 *    `playwright.config.ts`).
 *
 * If `SUPABASE_SECRET_KEY` is unset the fixture throws at the first
 * `test.use(...)` call so we fail fast rather than silently no-op.
 */

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SECRET_KEY;

/**
 * Lazily-built admin client. Throws a friendly error if env is missing so
 * Playwright surfaces the actual cause instead of a "Cannot read properties of
 * undefined" deep inside the supabase SDK.
 */
function getAdminClient(): SupabaseClient<Database> {
  if (!supabaseUrl) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL is required for e2e tests — set it in .env.local before running pnpm test:e2e.",
    );
  }
  if (!serviceRoleKey) {
    throw new Error(
      "SUPABASE_SECRET_KEY is required for e2e tests — set it in .env.local before running pnpm test:e2e.",
    );
  }
  return createClient<Database>(supabaseUrl, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}

export const TEST_CLIENT_SLUG = "test-e2e-client";
export const TEST_CLIENT_NAME = "E2E Test Client";

/**
 * Returns the same lazily-built service-role client `_fixtures.ts` /
 * `_seed.ts` use internally. Exposed for spec files (and the SSE mock
 * harness) that need to read state the API doesn't expose directly —
 * e.g. waiting for an autosave to land in `pipelines.config_draft`
 * before driving the next UI step, or asserting that a row reached
 * `status='done'` after the auto-advance trigger fired.
 *
 * Same env requirements + throw behaviour as the local `getAdminClient`
 * — fails fast with a friendly error if `SUPABASE_SECRET_KEY` is
 * unset.
 */
export function getTestAdminClient(): SupabaseClient<Database> {
  return getAdminClient();
}

/**
 * Upserts the canonical e2e test client by slug. Idempotent — repeated calls
 * return the same row id. Returns the row's `id` (uuid) for use in form
 * client-pickers and downstream cleanup queries.
 */
export async function ensureTestClient(): Promise<string> {
  const admin = getAdminClient();
  const { data, error } = await admin
    .from("clients")
    .upsert(
      {
        slug: TEST_CLIENT_SLUG,
        name: TEST_CLIENT_NAME,
        service_type: "remodeling",
        status: "active",
      },
      { onConflict: "slug" },
    )
    .select("id")
    .single();
  if (error || !data) {
    throw new Error(`ensureTestClient failed: ${error?.message ?? "no row returned"}`);
  }
  return data.id;
}

/**
 * Removes all image + video briefs owned by the given client id. Cascades to
 * any child rows (creatives, iterations, events) that have ON DELETE CASCADE,
 * so we don't have to enumerate every table here.
 */
export async function cleanupBriefs(clientId: string): Promise<void> {
  const admin = getAdminClient();
  // Image briefs first, then video briefs. Errors are surfaced so a flaky
  // cleanup doesn't silently leak rows into the next test.
  const imageRes = await admin.from("briefs").delete().eq("client_id", clientId);
  if (imageRes.error) {
    throw new Error(`cleanupBriefs (image) failed: ${imageRes.error.message}`);
  }
  const videoRes = await admin.from("video_briefs").delete().eq("client_id", clientId);
  if (videoRes.error) {
    throw new Error(`cleanupBriefs (video) failed: ${videoRes.error.message}`);
  }
}

export { expect };

// Re-export the seed/cleanup helpers so spec files can import everything
// from a single module (`./_fixtures`) rather than juggling two imports.
export {
  cleanupCampaignPerf,
  cleanupCreatives,
  cleanupLaunchPackages,
  cleanupPipelines,
  seedApprovedBrief,
  seedCampaignPerf,
  seedCreative,
  seedPipeline,
  seedPushedLaunch,
  seedVideoCreative,
};
export type {
  BriefFormat,
  SeedCampaignPerfRow,
  SeedCreativeOpts,
  SeedPipelineOpts,
  SeedVideoCreativeOpts,
};

/**
 * Aggregate teardown: wipes everything the Wave 5 specs may have seeded for
 * the given client. Order matters — campaign_perf rows aren't FK-linked to
 * briefs, so we can drop them first. Launch packages reference briefs via
 * FK, and `cleanupBriefs` cascades creatives + iterations + events, so once
 * launches + perf rows are gone the brief delete sweeps the rest.
 */
async function cleanupAll(clientId: string): Promise<void> {
  await cleanupCampaignPerf(clientId);
  await cleanupLaunchPackages(clientId);
  // Pipelines reference briefs (FK image_brief_id / video_brief_id). We
  // drop pipelines first so the brief sweep doesn't trip on the FK.
  await cleanupPipelines(clientId);
  await cleanupCreatives(clientId);
  await cleanupBriefs(clientId);
}

/**
 * Extended test fixture exposing `clientId` — the uuid of the upserted
 * `test-e2e-client`. The fixture wipes briefs both before and after each test
 * so leftover rows from a previous (possibly failed) run don't contaminate the
 * current one.
 *
 * Cleanup covers the Wave 5 surface too — launch packages and campaign_perf
 * rows — so specs only ever need to call `seedXxx` and let teardown handle
 * the rest.
 *
 * AUTH: the single-operator session gate (`middleware.ts`) is active, so the
 * fixture also injects a valid signed session cookie into the browser context
 * before each test (see `seedSessionCookie`). Every spec's `page.goto(...)`
 * then passes the gate without walking the login form. The auto-used `auth`
 * fixture runs ahead of the test body purely for its side effect.
 */
// Playwright fixtures expose a function parameter named `use`, which the
// react-hooks/rules-of-hooks ESLint rule (enabled by eslint-config-next)
// mistakes for a React Hook call. It's not — it's Playwright's "yield" — so
// we disable the rule scoped to this block.
/* eslint-disable react-hooks/rules-of-hooks */
export const test = base.extend<{ clientId: string; auth: void }>({
  auth: [
    async ({ context }, use) => {
      await seedSessionCookie(context);
      await use();
    },
    { auto: true },
  ],
  clientId: async ({}, use) => {
    const id = await ensureTestClient();
    await cleanupAll(id);
    await use(id);
    await cleanupAll(id);
  },
});
/* eslint-enable react-hooks/rules-of-hooks */
