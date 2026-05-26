import { test, expect, getTestAdminClient, seedApprovedBrief } from "./_fixtures";

/**
 * Bulk archive happy path on the unified Briefs list (Makeover M7).
 *
 * Drives the shared DataTable + ResourceShell bulk-action bar end to end:
 *
 *   1. Seed two image briefs for the canonical test client.
 *   2. Navigate to /briefs; both rows show in the active list.
 *   3. Tick the page-level select-all checkbox in the table header.
 *   4. Click "Archive" in the bulk-action bar and confirm in the dialog.
 *   5. Both briefs leave the active list AND their DB tombstones (deleted_at,
 *      migration 0049) flip to non-null.
 *
 * Archive is reversible (soft delete), so the spec checks the actual DB state
 * rather than trusting the UI — the same guard the briefs CRUD spec uses.
 */

test.describe("briefs bulk archive", () => {
  test("select multiple -> Archive bulk action -> rows archived in DB", async ({
    page,
    clientId,
  }) => {
    const idA = await seedApprovedBrief(clientId, "image");
    const idB = await seedApprovedBrief(clientId, "image");
    const admin = getTestAdminClient();

    await page.goto("/briefs");

    // Both rows show in the active list.
    const rowA = page.locator(`tr:has(a[href="/briefs/${idA}"])`);
    const rowB = page.locator(`tr:has(a[href="/briefs/${idB}"])`);
    await expect(rowA).toBeVisible({ timeout: 15_000 });
    await expect(rowB).toBeVisible();

    // Use the header select-all checkbox to grab every page row at once.
    await page.getByRole("checkbox", { name: /select all rows on this page/i }).click();

    // The bulk-action bar appears with the selected count and an Archive button.
    const bar = page.getByRole("region", { name: /bulk actions/i });
    await expect(bar).toBeVisible();
    await expect(bar.getByText(/2 selected/i)).toBeVisible();
    await bar.getByRole("button", { name: /^archive$/i }).click();

    // Confirm in the dialog.
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: /^archive$/i }).click();

    // Both DB tombstones flip.
    for (const id of [idA, idB]) {
      await expect
        .poll(
          async () => {
            const { data } = await admin
              .from("briefs")
              .select("deleted_at")
              .eq("id", id)
              .maybeSingle();
            return data?.deleted_at ?? null;
          },
          { timeout: 15_000 },
        )
        .not.toBeNull();
    }

    // The rows are gone from the active list.
    await page.goto("/briefs");
    await expect(page.locator(`tr:has(a[href="/briefs/${idA}"])`)).toHaveCount(0, {
      timeout: 15_000,
    });
    await expect(page.locator(`tr:has(a[href="/briefs/${idB}"])`)).toHaveCount(0);

    // Archived view shows both again.
    await page.goto("/briefs?archived=1");
    await expect(page.locator(`tr:has(a[href="/briefs/${idA}"])`)).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.locator(`tr:has(a[href="/briefs/${idB}"])`)).toBeVisible();
  });
});
