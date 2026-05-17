import { test, expect, seedApprovedBrief, seedVideoCreative } from "./_fixtures";

/**
 * Video creative loop (V2-19 / #106).
 *
 * Mirrors `image-creative-loop.spec.ts` for the `/creatives/video/[briefId]`
 * surface, with two video-specific assertions:
 *
 *  - The side panel renders the brief's `script_outline`: a "Hook" block
 *    plus one row per segment. The seeded brief has a single 30s
 *    "Drone overview" segment; the spec asserts both pieces show up.
 *  - The decision API for video creatives has a stricter state machine
 *    than the image side — approve only fires from `captioned`. We test:
 *      * a `captioned` creative can be approved through the UI
 *      * a `composed` creative can be rejected (approve button hidden,
 *        reject still works with confirm dialog)
 *      * a non-captioned creative cannot be approved — the API returns 409
 *        if you try to hit it directly.
 *
 * NOTE: like the image spec, this does NOT depend on the worker producing
 * files. The seeded `video_creatives` rows leave all `*_path` columns null,
 * so the preview tiles fall back to the Clapperboard placeholder and the
 * side panel shows the "No video render yet" empty state.
 */

test.describe("video creative loop", () => {
  test("captioned creative → side panel shows script + approve flows", async ({
    page,
    clientId,
  }) => {
    const briefId = await seedApprovedBrief(clientId, "video");
    await seedVideoCreative(briefId, {
      status: "captioned",
      version: 1,
      duration_actual_s: 30,
    });

    await page.goto(`/creatives/video/${briefId}`);

    // The grid label "Captioned" appears both in the brief-header count
    // pills AND in the tile's status pill — restrict to the tile.
    await expect(page.locator("[aria-pressed]").first()).toBeVisible();

    // Click the first tile (the only one). The tiles are <button> elements
    // with aria-pressed; clicking opens the side panel.
    await page.locator("[aria-pressed]").first().click();

    const sidePanel = page.getByRole("dialog");
    await expect(sidePanel).toBeVisible();

    // Script section: assert the hook is visible AND the segment row from
    // the seeded brief renders ("Drone overview" — see seedApprovedBrief).
    await expect(sidePanel.getByText(/Watch what happens to your roof/i)).toBeVisible();
    await expect(sidePanel.getByText(/Drone overview/i)).toBeVisible();

    // Decision section: at `captioned` the Approve button is visible.
    const approveBtn = sidePanel.getByRole("button", { name: /^approve$/i });
    await expect(approveBtn).toBeVisible();
    await approveBtn.click();

    // The status pill flips to "Approved" once the decision POST round-trips.
    await expect(sidePanel.getByText(/^Approved$/).first()).toBeVisible({
      timeout: 15_000,
    });
    // After approval the decision button is gone (decisionToStatus
    // moves the row into a terminal state).
    await expect(sidePanel.getByRole("button", { name: /^approve$/i })).toHaveCount(0);
  });

  test("composed creative → approve button hidden, reject works", async ({ page, clientId }) => {
    const briefId = await seedApprovedBrief(clientId, "video");
    await seedVideoCreative(briefId, {
      status: "composed",
      version: 1,
      duration_actual_s: 30,
    });

    await page.goto(`/creatives/video/${briefId}`);
    await page.locator("[aria-pressed]").first().click();

    const sidePanel = page.getByRole("dialog");
    await expect(sidePanel).toBeVisible();

    // Approve is NOT visible from `composed` — only Reject.
    await expect(sidePanel.getByRole("button", { name: /^approve$/i })).toHaveCount(0);
    const rejectBtn = sidePanel.getByRole("button", { name: /^reject$/i });
    await expect(rejectBtn).toBeVisible();

    // The "Pipeline in progress" hint is rendered as a sibling to the
    // button row when only reject is available.
    await expect(sidePanel.getByText(/pipeline in progress/i)).toBeVisible();

    // Reject + confirm. The component uses window.confirm() — accept it.
    page.once("dialog", (d) => d.accept());
    await rejectBtn.click();
    await expect(sidePanel.getByText(/^Rejected$/).first()).toBeVisible({
      timeout: 15_000,
    });
  });

  test("decision API: approving a non-captioned video creative returns 409", async ({
    page,
    clientId,
  }) => {
    const briefId = await seedApprovedBrief(clientId, "video");
    // Seed in `composed` — approve is invalid until `captioned`.
    const creativeId = await seedVideoCreative(briefId, {
      status: "composed",
      version: 1,
    });

    const res = await page.request.post(`/api/creatives/video/${creativeId}/decision`, {
      data: { decision: "approve" },
    });
    expect(res.status()).toBe(409);
    const body = (await res.json()) as { error?: string; current?: string };
    expect(body.error).toBe("invalid_state");
    expect(body.current).toBe("composed");
  });
});
