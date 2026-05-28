import { test, expect, seedApprovedBrief, seedCreative, seedPushedLaunch } from "./_fixtures";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/types.gen";

/**
 * Image launch package end-to-end (M3-8 / #51).
 *
 * Three slices:
 *
 *  1. POST /api/launches happy path — seeds an approved brief plus one
 *     approved creative (with a stub Drive URL) and one paired copy
 *     variant, hits the builder API, asserts 201 + status "posted".
 *
 *  2. Approval gate happy path — drives the rendered `/launches/[id]`
 *     page, clicks "Approve" without notes, expects the status pill
 *     to flip to "Approved".
 *
 *  3. Pre-flight failure — POST with a brief that has an approved
 *     creative but NO paired copy. Expects 422 + a stable error
 *     payload listing the missing copy issue.
 *
 *  4. State machine — once a launch is in `approved` status, hitting
 *     the decision API again returns 409.
 */

// Helper: insert one copy_variants row tied to a creative. The launch
// builder treats any matching row as enough to clear "no paired copy".
async function seedCopyVariant(creativeId: string): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY are required for e2e tests.");
  }
  const admin: SupabaseClient<Database> = createClient<Database>(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
  const { error } = await admin.from("copy_variants").insert({
    creative_id: creativeId,
    headline: "Test headline",
    body: "Test body copy.",
    cta: "Learn more",
    status: "approved",
  });
  if (error) {
    throw new Error(`seedCopyVariant failed: ${error.message}`);
  }
}

test.describe("image launch package", () => {
  test("POST /api/launches happy path → 201 posted", async ({ page, clientId }) => {
    const briefId = await seedApprovedBrief(clientId, "image");
    const creativeId = await seedCreative(briefId, {
      concept: "Hero",
      ratio: "1x1",
      status: "approved",
      file_path_drive: "drive://stub",
    });
    await seedCopyVariant(creativeId);

    const res = await page.request.post("/api/launches", {
      data: { brief_id: briefId },
    });
    expect(res.status()).toBe(201);
    const body = (await res.json()) as {
      launch?: { id: string; status: string; brief_id: string };
    };
    expect(body.launch?.status).toBe("posted");
    expect(body.launch?.brief_id).toBe(briefId);
    expect(typeof body.launch?.id).toBe("string");
  });

  test("approval gate: posted → Approve → Approved", async ({ page, clientId }) => {
    const briefId = await seedApprovedBrief(clientId, "image");
    // Seed the launch directly in `posted` — the builder's pre-flight
    // already passed in test (1); here we just want the gate.
    const launchId = await seedPushedLaunch(briefId);

    await page.goto(`/launches/${launchId}`);

    // The status pill is rendered in the header.
    await expect(page.getByText("Posted", { exact: true })).toBeVisible();

    // ApprovalGate renders three buttons: Approve / Approve with changes /
    // Reject. A clean approval needs no notes.
    const approveBtn = page.getByRole("button", { name: /^approve$/i });
    await expect(approveBtn).toBeVisible();
    await approveBtn.click();

    // Mirrors the launch-video equivalent: the router.refresh() re-render of
    // the Supabase-heavy launch detail page can exceed 15s on a busy CI
    // runner (especially on a re-run where the runner is already warm with
    // images). 30s removes the flake without masking a real hang.
    await expect(page.getByText("Approved", { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    // Gate disappears after a non-posted transition.
    await expect(page.getByRole("button", { name: /^approve$/i })).toHaveCount(0);
  });

  test("approval gate: approve_with_changes requires notes", async ({ page, clientId }) => {
    const briefId = await seedApprovedBrief(clientId, "image");
    const launchId = await seedPushedLaunch(briefId);

    await page.goto(`/launches/${launchId}`);
    await expect(page.getByText("Posted", { exact: true })).toBeVisible();

    // Click without notes -- client-side validation blocks the submit. The
    // gate renders the error inside a role=alert region, but Next's
    // __next-route-announcer__ ALSO carries role=alert, so a bare
    // page.getByRole("alert") is a strict-mode violation. Scope the locator
    // to the gate's own region by anchoring on its required-notes text.
    await page.getByRole("button", { name: /approve with changes/i }).click();
    const gateAlert = page.getByRole("alert").filter({ hasText: /notes are required/i });
    await expect(gateAlert).toBeVisible();
    // Status unchanged.
    await expect(page.getByText("Posted", { exact: true })).toBeVisible();

    // Provide notes and retry -- the launch flips to approved_with_changes.
    await page.getByLabel(/notes/i).fill("Adjust the body copy then ship.");
    await page.getByRole("button", { name: /approve with changes/i }).click();
    await expect(page.getByText(/Approved with changes/i).first()).toBeVisible({
      timeout: 15_000,
    });
  });

  test("POST /api/launches with missing copy → 422", async ({ page, clientId }) => {
    const briefId = await seedApprovedBrief(clientId, "image");
    await seedCreative(briefId, {
      concept: "Lonely Creative",
      ratio: "1x1",
      status: "approved",
      file_path_drive: "drive://stub",
      // No copy variant seeded → pre-flight should reject.
    });

    const res = await page.request.post("/api/launches", {
      data: { brief_id: briefId },
    });
    expect(res.status()).toBe(422);
    const body = (await res.json()) as {
      launch?: {
        status: string;
        payload?: { issues?: Array<{ severity: string; message: string }> };
      };
    };
    expect(body.launch?.status).toBe("failed");
    const issues = body.launch?.payload?.issues ?? [];
    const messages = issues.map((i) => `${i.severity}:${i.message}`);
    // The pre-flight pipeline emits "Creative has no paired copy variants."
    // We don't pin the wording — just assert at least one error-level
    // issue mentions copy.
    expect(messages.some((m) => m.startsWith("error:") && /copy/i.test(m))).toBe(true);
  });

  test("decision API: deciding a non-posted launch returns 409", async ({ page, clientId }) => {
    // Approve the launch via the decision API once, then try again.
    const briefId = await seedApprovedBrief(clientId, "image");
    const launchId = await seedPushedLaunch(briefId);

    const first = await page.request.post(`/api/launches/${launchId}/decision`, {
      data: { decision: "approved" },
    });
    expect(first.status()).toBe(200);

    const second = await page.request.post(`/api/launches/${launchId}/decision`, {
      data: { decision: "rejected", notes: "should not work" },
    });
    expect(second.status()).toBe(409);
    const body = (await second.json()) as { error?: string; current?: string };
    expect(body.error).toBe("invalid_state");
    expect(body.current).toBe("approved");
  });
});
