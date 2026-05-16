import { test, expect, TEST_CLIENT_NAME } from "./_fixtures";

/**
 * Video brief lifecycle (V1-10 / #87).
 *
 * Mirrors the image-brief spec for the `/briefs/video/*` flow with two
 * additions specific to the video schema:
 *
 *  - The "sum of segment durations equals target_duration_s (±1s)" zod
 *    refinement (see `VideoBriefInput` in `lib/video-briefs.ts`). The form
 *    surfaces this both in a live preview ("Sum 15s / target 30s mismatch")
 *    and as a server-side validation error on submit. The negative test
 *    asserts the live preview signals the mismatch.
 *  - The video brief detail URL is `/briefs/video/{id}`, not `/briefs/{id}`.
 */

const ROUTE_DETAIL_RE = /\/briefs\/video\/[a-f0-9-]{36}$/;

test.describe("video brief lifecycle", () => {
  test("draft → post → approve happy path", async ({ page, clientId }) => {
    void clientId;

    await page.goto("/briefs/video/new");

    // Client picker is a Radix Select — click + pick by accessible name.
    const clientTrigger = page.locator("#client_id");
    await expect(clientTrigger).toBeEnabled();
    await clientTrigger.click();
    await page.getByRole("option", { name: new RegExp(TEST_CLIENT_NAME, "i") }).click();

    await page.getByLabel(/voice id/i).fill("21m00Tcm4TlvDq8ikWAM");
    await page.getByLabel(/^hook$/i).fill("Watch what happens to your roof in 60 seconds.");

    // The default form ships with target_duration_s=30 and a single 15s
    // segment — fix the segment to match. Otherwise the zod refinement
    // rejects the submit with "sum of segment durations must equal
    // target_duration_s (±1s)".
    await page.getByLabel(/topic/i).fill("Drone roof overview");
    const durationField = page.getByLabel(/duration \(s\)/i);
    await durationField.fill("30");

    // Post for approval — same single-step pattern as the image spec.
    await page.getByRole("button", { name: /post for approval/i }).click();

    await expect(page).toHaveURL(ROUTE_DETAIL_RE);
    await expect(page.getByText("posted", { exact: true })).toBeVisible();

    // Approval gate renders for status=posted. Notes are optional for a
    // clean approval.
    await page.getByRole("button", { name: /^approve$/i }).click();

    // After approve the page calls router.refresh(); the server re-renders
    // with status="approved" and the gate disappears.
    await expect(page.getByText("approved", { exact: true })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByRole("button", { name: /^approve$/i })).toHaveCount(0);
  });

  test("segment-sum mismatch is surfaced in the live preview", async ({ page, clientId }) => {
    void clientId;

    await page.goto("/briefs/video/new");

    // Defaults: target_duration_s=30, one segment with duration_s=15. The
    // preview should already render "mismatch" because 15 !== 30.
    await expect(page.getByText(/sum/i)).toContainText("15s");
    await expect(page.getByText(/target/i)).toContainText("30s");
    await expect(page.getByText(/mismatch/i)).toBeVisible();

    // Bump the segment duration to 30 — preview should clear the mismatch.
    const durationField = page.getByLabel(/duration \(s\)/i);
    await durationField.fill("30");
    await expect(page.getByText(/mismatch/i)).toHaveCount(0);
  });

  test("approve_with_changes requires notes", async ({ page, clientId }) => {
    void clientId;

    // Seed a posted video brief inline.
    await page.goto("/briefs/video/new");
    const clientTrigger = page.locator("#client_id");
    await expect(clientTrigger).toBeEnabled();
    await clientTrigger.click();
    await page.getByRole("option", { name: new RegExp(TEST_CLIENT_NAME, "i") }).click();
    await page.getByLabel(/voice id/i).fill("21m00Tcm4TlvDq8ikWAM");
    await page.getByLabel(/^hook$/i).fill("Hook copy long enough to pass min().");
    await page.getByLabel(/topic/i).fill("Intro shot");
    await page.getByLabel(/duration \(s\)/i).fill("30");
    await page.getByRole("button", { name: /post for approval/i }).click();
    await expect(page).toHaveURL(ROUTE_DETAIL_RE);

    // No notes → client-side validation blocks the request and surfaces the
    // alert. Server-side rule mirrored in VideoApprovalGate.tsx.
    await page.getByRole("button", { name: /approve with changes/i }).click();
    await expect(page.getByRole("alert")).toContainText(/notes are required/i);
    await expect(page.getByText("posted", { exact: true })).toBeVisible();

    // With notes, the transition goes through.
    await page.getByLabel(/^notes$/i).fill("Tighten the hook to 5 seconds.");
    await page.getByRole("button", { name: /approve with changes/i }).click();
    await expect(page.getByText("approved_with_changes", { exact: true })).toBeVisible({
      timeout: 15_000,
    });
  });
});
