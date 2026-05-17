import { test, expect, TEST_CLIENT_NAME } from "./_fixtures";

/**
 * Pipeline both-tracks happy path (PF-G-3 / #204).
 *
 * Verifies that `format='both'` renders the Configuration stage with both
 * the image AND video brief fieldsets side-by-side. The same UI-scope
 * exclusions apply as in `pipeline-image.spec.ts` / `pipeline-video.spec.ts`
 * — worker-dependent transitions are out of scope here.
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
});
