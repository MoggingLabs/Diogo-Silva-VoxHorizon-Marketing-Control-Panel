import { test as base, expect } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/types.gen";

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
 *  - `SUPABASE_SERVICE_ROLE_KEY`    — required. Read from `.env.local` (Next.js
 *    autoloads `.env.local` for the dev server; the test runner reads it from
 *    `process.env` after Playwright spawns the dev server, so callers may need
 *    to source these into the runner's env explicitly).
 *  - `PLAYWRIGHT_BASE_URL`          — optional, defaults to localhost:3000 (see
 *    `playwright.config.ts`).
 *
 * If `SUPABASE_SERVICE_ROLE_KEY` is unset the fixture throws at the first
 * `test.use(...)` call so we fail fast rather than silently no-op.
 */

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

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
      "SUPABASE_SERVICE_ROLE_KEY is required for e2e tests — set it in .env.local before running pnpm test:e2e.",
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

/**
 * Extended test fixture exposing `clientId` — the uuid of the upserted
 * `test-e2e-client`. The fixture wipes briefs both before and after each test
 * so leftover rows from a previous (possibly failed) run don't contaminate the
 * current one.
 */
// Playwright fixtures expose a function parameter named `use`, which the
// react-hooks/rules-of-hooks ESLint rule (enabled by eslint-config-next)
// mistakes for a React Hook call. It's not — it's Playwright's "yield" — so
// we disable the rule scoped to this block.
/* eslint-disable react-hooks/rules-of-hooks */
export const test = base.extend<{ clientId: string }>({
  clientId: async ({}, use) => {
    const id = await ensureTestClient();
    await cleanupBriefs(id);
    await use(id);
    await cleanupBriefs(id);
  },
});
/* eslint-enable react-hooks/rules-of-hooks */
