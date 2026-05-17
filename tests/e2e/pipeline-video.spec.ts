import { test, expect, TEST_CLIENT_NAME } from "./_fixtures";

/**
 * Pipeline video-only happy path (PF-G-3 / #204).
 *
 * Mirrors `pipeline-image.spec.ts` for the video track. Same UI scope —
 * Configuration → Ideation scaffolding plus the cancel-pipeline flow.
 * Generation / Done depend on the worker and are excluded by design;
 * see the image spec for the full rationale.
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
});
