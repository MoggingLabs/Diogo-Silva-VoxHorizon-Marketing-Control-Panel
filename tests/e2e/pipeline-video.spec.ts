import { test, expect, getTestAdminClient, TEST_CLIENT_NAME } from "./_fixtures";
import { mockWorkerGeneration, mockWorkerIdeation } from "./_mocks/sse-harness";

/**
 * Pipeline video-only happy path (PF-G-3 / #204).
 *
 * Mirrors `pipeline-image.spec.ts` for the video track. Configuration uses
 * the video brief form (hook, segments, voice_id); ideation seeds video
 * drafts; generation drives six substages per pick (script, voiceover,
 * broll_search, broll_pick, compose, caption) and auto-advances to Done
 * on the last `task_done` via the DB trigger.
 *
 * The cancel-from-Configuration spec from Wave 13 stays as a separate
 * `test()` so we keep coverage of both paths.
 */

test.describe("pipeline — video format", () => {
  test("create → switch to video → cancel", async ({ page, clientId }) => {
    void clientId;

    await page.goto("/pipeline/new");
    await expect(page).toHaveURL(/\/pipeline\/[a-f0-9-]{36}$/);

    // Configuration stage renders by default.
    await expect(page.getByText("Configuration", { exact: true }).first()).toBeVisible();

    // Switch the format radio to "video". This fires an autosave PATCH —
    // the new Video brief fieldset takes the place of the image one.
    await page.getByLabel("Video", { exact: true }).click();

    // Pick the test client.
    const clientTrigger = page.locator("#stage-config-client");
    await expect(clientTrigger).toBeEnabled();
    await clientTrigger.click();
    await page.getByRole("option", { name: new RegExp(TEST_CLIENT_NAME, "i") }).click();

    // Video brief fieldset is mounted; the hook + segments + voice fields
    // are required for the Continue gate to clear.
    await expect(page.getByText(/video brief/i)).toBeVisible();
    await expect(page.getByLabel(/^hook$/i)).toBeVisible();
    await expect(page.getByText(/script segments/i)).toBeVisible();
    await expect(page.getByLabel(/voice id/i)).toBeVisible();

    // Verify the pipeline format badge updated.
    await expect(page.getByText(/^Video$/i).first()).toBeVisible();

    // Cancel the pipeline from the Configuration stage.
    const cancelBtn = page.getByRole("button", { name: /cancel pipeline/i });
    await expect(cancelBtn).toBeVisible();
    await cancelBtn.click();

    await expect(page.getByRole("dialog")).toBeVisible();
    const confirmBtn = page.getByRole("button", { name: /^cancel pipeline$/i }).last();
    await confirmBtn.click();

    await expect(page.getByText("Cancelled", { exact: true })).toBeVisible({ timeout: 15_000 });
  });

  test("video segments can be added and removed", async ({ page, clientId }) => {
    void clientId;

    await page.goto("/pipeline/new");
    await expect(page).toHaveURL(/\/pipeline\/[a-f0-9-]{36}$/);

    await page.getByLabel("Video", { exact: true }).click();

    // The video form ships with one default segment and an "Add segment" button.
    await expect(page.getByLabel(/^topic$/i)).toHaveCount(1);

    await page.getByRole("button", { name: /add segment/i }).click();
    await expect(page.getByLabel(/^topic$/i)).toHaveCount(2);

    // The remove button on the FIRST segment now becomes interactive (it's
    // disabled when only one segment exists).
    const removeBtns = page.getByRole("button", { name: /^remove$/i });
    await expect(removeBtns).toHaveCount(2);
    await removeBtns.first().click();
    await expect(page.getByLabel(/^topic$/i)).toHaveCount(1);
  });

  test("full happy path: configuration → ideation → review → generation → done", async ({
    page,
    clientId,
  }) => {
    void clientId;

    // -----------------------------------------------------------------
    // Step 1. Create + switch to video.
    // -----------------------------------------------------------------
    await page.goto("/pipeline/new");
    await expect(page).toHaveURL(/\/pipeline\/[a-f0-9-]{36}$/);
    const url = page.url();
    const pipelineId = url.match(/\/pipeline\/([a-f0-9-]{36})$/)?.[1];
    if (!pipelineId) throw new Error(`could not extract pipeline id from ${url}`);

    await page.getByLabel("Video", { exact: true }).click();

    // -----------------------------------------------------------------
    // Step 2. Pick client + fill video brief.
    // -----------------------------------------------------------------
    const clientTrigger = page.locator("#stage-config-client");
    await expect(clientTrigger).toBeEnabled();
    await clientTrigger.click();
    await page.getByRole("option", { name: new RegExp(TEST_CLIENT_NAME, "i") }).click();

    await page.getByLabel(/^hook$/i).fill("Watch what happens in 60 seconds.");
    await page.getByLabel(/voice id/i).fill("21m00Tcm4TlvDq8ikWAM");
    // Fill the one default segment so the canonical schema passes.
    await page.getByLabel(/^topic$/i).fill("Drone overview");
    // VideoBriefInput refines `sum(segments.duration_s) === target_duration_s`
    // — the default form has one segment with duration_s=15 but target=30,
    // so flip the target down to 15 to clear the gate.
    await page.getByLabel(/target duration/i).fill("15");

    // Wait for autosave to land.
    await expect(page.getByText("Saved", { exact: true })).toBeVisible({ timeout: 15_000 });

    // -----------------------------------------------------------------
    // Step 3. Advance to Ideation.
    // -----------------------------------------------------------------
    const continueBtn = page.getByRole("button", { name: /continue to ideation/i });
    await expect(continueBtn).toBeEnabled();
    await continueBtn.click();
    await expect(page.getByText("Ideation", { exact: true }).first()).toBeVisible({
      timeout: 15_000,
    });

    // -----------------------------------------------------------------
    // Step 4. Seed video ideation drafts (3 is the worker's default).
    // -----------------------------------------------------------------
    const seeded = await mockWorkerIdeation(page, { pipelineId, n: 3 });
    expect(seeded.video).toHaveLength(3);

    await expect(page.getByText(/Picked:\s*0\s*of\s*3/)).toBeVisible({ timeout: 15_000 });

    // -----------------------------------------------------------------
    // Step 5. Pick the first video variant.
    // -----------------------------------------------------------------
    const pickedIds = [seeded.video[0]!.id];
    const pickButtons = page.getByRole("checkbox", { name: /pick video concept/i });
    await pickButtons.nth(0).click();
    await expect(page.getByText(/Video:\s*1\s*picked/)).toBeVisible();

    // -----------------------------------------------------------------
    // Step 6. Advance Ideation → Review.
    // -----------------------------------------------------------------
    await page.getByRole("button", { name: /continue to review/i }).click();
    await expect(page.getByText("Review", { exact: true }).first()).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText(/video picks/i)).toBeVisible();

    // -----------------------------------------------------------------
    // Step 7. Approve → Generation.
    // -----------------------------------------------------------------
    await page.getByRole("button", { name: /^approve$/i }).click();
    await expect(page.getByText("Generation", { exact: true }).first()).toBeVisible({
      timeout: 15_000,
    });

    // -----------------------------------------------------------------
    // Step 8. Drive the substage chain; trigger auto-advances to Done.
    // -----------------------------------------------------------------
    await mockWorkerGeneration(page, {
      pipelineId,
      picks: { video: pickedIds },
    });

    await expect(page.getByText("Done", { exact: true }).first()).toBeVisible({
      timeout: 20_000,
    });

    // Verify server-side row reached `done`.
    const admin = getTestAdminClient();
    const { data: finalPipeline } = await admin
      .from("pipelines")
      .select("status")
      .eq("id", pipelineId)
      .maybeSingle();
    expect(finalPipeline?.status).toBe("done");

    // -----------------------------------------------------------------
    // Step 9. Done stage — video gallery + launch CTA.
    // -----------------------------------------------------------------
    await expect(page.getByText(/video finals/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /build launch package/i })).toBeVisible();
  });
});
