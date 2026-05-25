import { test, expect, getTestAdminClient, seedPipeline } from "./_fixtures";

/**
 * Pipeline archive / restore happy path (#609).
 *
 * The operator could previously only CANCEL a pipeline (a status flip that
 * keeps it in the list). This spec exercises the new soft-archive:
 *
 *   1. Seed an active pipeline for the test client.
 *   2. Visit /pipeline -> the row is in the default (active) list.
 *   3. Archive it via the row action menu + confirm dialog.
 *   4. It disappears from the default list (deleted_at hides it).
 *   5. It appears under the "Archived" filter, with a Restore action.
 *   6. Restore it -> it returns to the active list.
 *
 * Soft, not hard: the pipeline is the orchestration root, so archive sets
 * `deleted_at` (migration 0048) and is fully reversible -- we assert the DB
 * tombstone is set after archive and cleared after restore.
 */

test.describe("pipeline archive / restore", () => {
  test("archive hides a pipeline from the active list, restore brings it back", async ({
    page,
    clientId,
  }) => {
    // Step 1. Seed an active pipeline owned by the test client. We use a
    // distinctive client name so the row is easy to target in the table; the
    // seeded client's real name is "E2E Test Client" (TEST_CLIENT_NAME).
    const pipelineId = await seedPipeline(clientId, { format_choice: "image" });

    const admin = getTestAdminClient();

    // Step 2. The active list shows the row by default. The client cell links
    // to the detail page, so we locate the row by its detail-page href.
    await page.goto("/pipeline");
    const activeRow = page.locator(`tr:has(a[href="/pipeline/${pipelineId}"])`);
    await expect(activeRow).toBeVisible();

    // Step 3. Open the row action menu and choose Archive.
    await activeRow.getByRole("button", { name: /pipeline actions/i }).click();
    await page.getByRole("menuitem", { name: /archive/i }).click();

    // Step 4. The confirm dialog opens; confirm the soft-archive.
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.getByRole("button", { name: /^archive$/i }).click();

    // Step 5. The row drops out of the default (active) list.
    await expect(page.locator(`tr:has(a[href="/pipeline/${pipelineId}"])`)).toHaveCount(0, {
      timeout: 15_000,
    });

    // The DB tombstone is set.
    await expect
      .poll(
        async () => {
          const { data } = await admin
            .from("pipelines")
            .select("deleted_at")
            .eq("id", pipelineId)
            .maybeSingle();
          return data?.deleted_at ?? null;
        },
        { timeout: 15_000 },
      )
      .not.toBeNull();

    // Step 6. Switch to the Archived view; the row shows up there with a
    // Restore action.
    await page.getByRole("button", { name: "Archived", pressed: false }).click();
    const archivedRow = page.locator(`tr:has(a[href="/pipeline/${pipelineId}"])`);
    await expect(archivedRow).toBeVisible({ timeout: 15_000 });

    // Step 7. Restore it.
    await archivedRow.getByRole("button", { name: /restore pipeline/i }).click();

    // It leaves the Archived view ...
    await expect(page.locator(`tr:has(a[href="/pipeline/${pipelineId}"])`)).toHaveCount(0, {
      timeout: 15_000,
    });

    // ... and the DB tombstone is cleared.
    await expect
      .poll(
        async () => {
          const { data } = await admin
            .from("pipelines")
            .select("deleted_at")
            .eq("id", pipelineId)
            .maybeSingle();
          return data?.deleted_at ?? null;
        },
        { timeout: 15_000 },
      )
      .toBeNull();

    // Step 8. Back in the default (active) list, the row is present again.
    await page.getByRole("button", { name: "All", pressed: false }).click();
    await expect(page.locator(`tr:has(a[href="/pipeline/${pipelineId}"])`)).toBeVisible({
      timeout: 15_000,
    });
  });
});
