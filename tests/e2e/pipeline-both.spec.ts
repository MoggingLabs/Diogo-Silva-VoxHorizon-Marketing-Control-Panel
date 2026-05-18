import { test, expect, getTestAdminClient, TEST_CLIENT_NAME } from "./_fixtures";
import { mockWorkerGeneration, mockWorkerIdeation } from "./_mocks/sse-harness";

/**
 * Pipeline both-tracks happy path (PF-G-3 / #204).
 *
 * Verifies that `format='both'` runs the full pipeline through both tracks
 * concurrently — Configuration renders side-by-side fieldsets, Ideation
 * seeds both image + video variants, Review shows both picks summaries,
 * and Done renders both galleries.
 *
 * The cancel-from-Configuration variant from Wave 13 remains as a separate
 * `test()` so both paths stay covered.
 */

test.describe("pipeline — both formats", () => {
  test("both tracks render side-by-side and cancel works", async ({ page, clientId }) => {
    void clientId;

    await page.goto("/pipeline/new");
    await expect(page).toHaveURL(/\/pipeline\/[a-f0-9-]{36}$/);

    // Switch format to "both". The form layout grows a second fieldset and
    // the format badge in the header flips to "Image + Video".
    await page.getByLabel("Both", { exact: true }).click();

    // Pick the test client.
    const clientTrigger = page.locator("#stage-config-client");
    await expect(clientTrigger).toBeEnabled();
    await clientTrigger.click();
    await page.getByRole("option", { name: new RegExp(TEST_CLIENT_NAME, "i") }).click();

    // Both fieldsets should be present.
    await expect(page.getByText(/image brief/i)).toBeVisible();
    await expect(page.getByText(/video brief/i)).toBeVisible();

    // Image-side required fields.
    await expect(page.getByLabel(/^market$/i)).toBeVisible();
    await expect(page.getByLabel(/total budget/i)).toBeVisible();

    // Video-side required fields.
    await expect(page.getByLabel(/^hook$/i)).toBeVisible();
    await expect(page.getByLabel(/voice id/i)).toBeVisible();

    // Header badge shows the combined format.
    await expect(page.getByText(/image \+ video/i).first()).toBeVisible();

    // Cancel from a non-terminal stage works as in the single-track specs.
    await page.getByRole("button", { name: /cancel pipeline/i }).click();
    await expect(page.getByRole("dialog")).toBeVisible();

    // "Keep running" closes the modal without changing state.
    await page.getByRole("button", { name: /keep running/i }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    // Status badge is still Configuration.
    await expect(page.getByText("Configuration", { exact: true }).first()).toBeVisible();

    // Re-open and confirm the cancel.
    await page.getByRole("button", { name: /cancel pipeline/i }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    const confirmBtn = page.getByRole("button", { name: /^cancel pipeline$/i }).last();
    await confirmBtn.click();

    await expect(page.getByText("Cancelled", { exact: true })).toBeVisible({ timeout: 15_000 });
  });

  test("full happy path: both tracks → ideation picks → review → generation → done", async ({
    page,
    clientId,
  }) => {
    void clientId;

    // -----------------------------------------------------------------
    // Step 1. Create + flip to both.
    // -----------------------------------------------------------------
    await page.goto("/pipeline/new");
    await expect(page).toHaveURL(/\/pipeline\/[a-f0-9-]{36}$/);
    const url = page.url();
    const pipelineId = url.match(/\/pipeline\/([a-f0-9-]{36})$/)?.[1];
    if (!pipelineId) throw new Error(`could not extract pipeline id from ${url}`);

    await page.getByLabel("Both", { exact: true }).click();

    // -----------------------------------------------------------------
    // Step 2. Client + both brief forms.
    // -----------------------------------------------------------------
    const clientTrigger = page.locator("#stage-config-client");
    await expect(clientTrigger).toBeEnabled();
    await clientTrigger.click();
    await page.getByRole("option", { name: new RegExp(TEST_CLIENT_NAME, "i") }).click();

    await page.getByLabel("Remodeling", { exact: true }).click();
    await page.getByLabel(/^market$/i).fill("Tampa, FL");
    await page.getByLabel(/total budget/i).fill("4200");
    await page.getByLabel(/landing page url/i).fill("https://example.com/tampa-lp");

    await page.getByLabel(/^hook$/i).fill("Watch what hurricane prep looks like.");
    await page.getByLabel(/voice id/i).fill("21m00Tcm4TlvDq8ikWAM");
    await page.getByLabel(/^topic$/i).fill("Drone overview");
    // Align target duration with the single default segment (15s) so the
    // VideoBriefInput refinement (`sum(segments.duration_s) ≈ target`)
    // doesn't block autosave.
    await page.getByLabel(/target duration/i).fill("15");

    await expect(page.getByText("Saved", { exact: true })).toBeVisible({ timeout: 15_000 });

    // -----------------------------------------------------------------
    // Step 3. Advance to Ideation.
    // -----------------------------------------------------------------
    await page.getByRole("button", { name: /continue to ideation/i }).click();
    await expect(page.getByText("Ideation", { exact: true }).first()).toBeVisible({
      timeout: 15_000,
    });

    // Both columns render.
    await expect(page.getByText(/image concepts/i)).toBeVisible();
    await expect(page.getByText(/video concepts/i)).toBeVisible();

    // -----------------------------------------------------------------
    // Step 4. Seed both tracks — image 4, video 3 (worker defaults).
    // -----------------------------------------------------------------
    const seeded = await mockWorkerIdeation(page, { pipelineId, n: 4 });
    // mockWorkerIdeation honours `n` for whatever tracks are active. For
    // `format=both` it seeds N in each. We override video to 3 by calling
    // the helper a second time after deleting and re-inserting if needed
    // — but for "both" we just want enough cards in each, so 4 is fine.
    expect(seeded.image).toHaveLength(4);
    expect(seeded.video).toHaveLength(4);

    // Verify both grids hydrated.
    await expect(page.getByText(/Picked:\s*0\s*of\s*4/).first()).toBeVisible({
      timeout: 15_000,
    });

    // -----------------------------------------------------------------
    // Step 5. Pick 2 image + 1 video.
    // -----------------------------------------------------------------
    const imagePicks = [seeded.image[0]!.id, seeded.image[1]!.id];
    const videoPicks = [seeded.video[0]!.id];

    const imageCheckboxes = page.getByRole("checkbox", { name: /pick concept/i });
    await imageCheckboxes.nth(0).click();
    await imageCheckboxes.nth(1).click();

    const videoCheckboxes = page.getByRole("checkbox", { name: /pick video concept/i });
    await videoCheckboxes.nth(0).click();

    await expect(page.getByText(/Image:\s*2\s*picked/)).toBeVisible();
    await expect(page.getByText(/Video:\s*1\s*picked/)).toBeVisible();

    // -----------------------------------------------------------------
    // Step 6. Advance → Review.
    // -----------------------------------------------------------------
    await page.getByRole("button", { name: /continue to review/i }).click();
    await expect(page.getByText("Review", { exact: true }).first()).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText(/image picks/i)).toBeVisible();
    await expect(page.getByText(/video picks/i)).toBeVisible();

    // -----------------------------------------------------------------
    // Step 7. Approve → Generation.
    // -----------------------------------------------------------------
    await page.getByRole("button", { name: /^approve$/i }).click();
    await expect(page.getByText("Generation", { exact: true }).first()).toBeVisible({
      timeout: 15_000,
    });

    // -----------------------------------------------------------------
    // Step 8. Seed generation chains for BOTH tracks — trigger flips to Done.
    // -----------------------------------------------------------------
    await mockWorkerGeneration(page, {
      pipelineId,
      picks: { image: imagePicks, video: videoPicks },
    });

    await expect(page.getByText("Done", { exact: true }).first()).toBeVisible({
      timeout: 25_000,
    });

    const admin = getTestAdminClient();
    const { data: finalPipeline } = await admin
      .from("pipelines")
      .select("status")
      .eq("id", pipelineId)
      .maybeSingle();
    expect(finalPipeline?.status).toBe("done");

    // -----------------------------------------------------------------
    // Step 9. Done stage — both galleries + launch CTA.
    // -----------------------------------------------------------------
    await expect(page.getByText(/image finals/i)).toBeVisible();
    await expect(page.getByText(/video finals/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /build launch package/i })).toBeVisible();
  });
});
