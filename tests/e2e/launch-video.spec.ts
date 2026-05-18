import { test, expect, seedApprovedBrief, seedPushedLaunch, seedVideoCreative } from "./_fixtures";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/types.gen";

/**
 * Video launch package end-to-end (V3-8 / #114).
 *
 * Mirrors `launch-image.spec.ts` for the `/launches/video/[id]` surface:
 *
 *  1. POST /api/launches/video happy path — seed an approved video brief
 *     with one `captioned` video creative, a captioned MP4 path, a Drive
 *     URL, and one paired copy variant; assert 201 / status "posted".
 *  2. Approval gate happy path — drive the page, click Approve, expect
 *     the status pill to flip.
 *  3. Pre-flight failure — POST without copy variants → 422.
 *  4. State-machine guard — deciding twice returns 409.
 */

async function seedVideoCopyVariant(videoCreativeId: string): Promise<void> {
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
  const { error } = await admin.from("video_copy_variants").insert({
    creative_id: videoCreativeId,
    headline: "Test video headline",
    body: "Test video body copy.",
    cta: "Watch now",
    status: "approved",
  });
  if (error) {
    throw new Error(`seedVideoCopyVariant failed: ${error.message}`);
  }
}

test.describe("video launch package", () => {
  test("POST /api/launches/video happy path → 201 posted", async ({ page, clientId }) => {
    const briefId = await seedApprovedBrief(clientId, "video");
    const creativeId = await seedVideoCreative(briefId, {
      status: "captioned",
      version: 1,
      captioned_path: "captioned/stub.mp4",
      drive_url: "drive://stub",
      duration_actual_s: 30,
    });
    await seedVideoCopyVariant(creativeId);

    const res = await page.request.post("/api/launches/video", {
      data: { brief_id: briefId },
    });
    expect(res.status()).toBe(201);
    const body = (await res.json()) as {
      launch?: { id: string; status: string; brief_id: string };
    };
    expect(body.launch?.status).toBe("posted");
    expect(body.launch?.brief_id).toBe(briefId);
  });

  test("approval gate: posted → Approve → Approved", async ({ page, clientId }) => {
    const briefId = await seedApprovedBrief(clientId, "video");
    const launchId = await seedPushedLaunch(briefId, "video");

    await page.goto(`/launches/video/${launchId}`);

    // Header status pill says "Posted".
    await expect(page.getByText("Posted", { exact: true })).toBeVisible();

    // VideoLaunchApprovalGate renders three buttons (see component) plus a
    // notes textarea. Clean approval needs no notes.
    const approveBtn = page.getByRole("button", { name: /^approve$/i });
    await expect(approveBtn).toBeVisible();
    await approveBtn.click();

    await expect(page.getByText("Approved", { exact: true })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByRole("button", { name: /^approve$/i })).toHaveCount(0);
  });

  test("approval gate: approve_with_changes requires notes", async ({ page, clientId }) => {
    const briefId = await seedApprovedBrief(clientId, "video");
    const launchId = await seedPushedLaunch(briefId, "video");

    await page.goto(`/launches/video/${launchId}`);
    await expect(page.getByText("Posted", { exact: true })).toBeVisible();

    // Click without notes — client-side validation should block + surface
    // an alert (see VideoLaunchApprovalGate.tsx).
    await page.getByRole("button", { name: /approve with changes/i }).click();
    await expect(page.getByRole("alert")).toContainText(/notes are required/i);
    await expect(page.getByText("Posted", { exact: true })).toBeVisible();

    // With notes the launch transitions.
    await page.getByLabel(/notes/i).fill("Tighten the hook.");
    await page.getByRole("button", { name: /approve with changes/i }).click();
    await expect(page.getByText(/Approved with changes/i)).toBeVisible({
      timeout: 15_000,
    });
  });

  test("POST /api/launches/video with missing copy → 422", async ({ page, clientId }) => {
    const briefId = await seedApprovedBrief(clientId, "video");
    await seedVideoCreative(briefId, {
      status: "captioned",
      version: 1,
      captioned_path: "captioned/stub.mp4",
      drive_url: "drive://stub",
      duration_actual_s: 30,
      // No copy variant — pre-flight should reject.
    });

    const res = await page.request.post("/api/launches/video", {
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
    expect(messages.some((m) => m.startsWith("error:") && /copy/i.test(m))).toBe(true);
  });

  test("decision API: deciding a non-posted video launch returns 409", async ({
    page,
    clientId,
  }) => {
    const briefId = await seedApprovedBrief(clientId, "video");
    const launchId = await seedPushedLaunch(briefId, "video");

    const first = await page.request.post(`/api/launches/video/${launchId}/decision`, {
      data: { decision: "approved" },
    });
    expect(first.status()).toBe(200);

    const second = await page.request.post(`/api/launches/video/${launchId}/decision`, {
      data: { decision: "rejected", notes: "should not work" },
    });
    expect(second.status()).toBe(409);
    const body = (await second.json()) as { error?: string; current?: string };
    expect(body.error).toBe("invalid_state");
    expect(body.current).toBe("approved");
  });
});
