import { test, expect, getTestAdminClient, seedApprovedBrief, seedPushedLaunch } from "./_fixtures";

/**
 * Unified Launches management happy path (E5.1 / #595).
 *
 * The makeover folds image + video launch packages into one /launches section
 * with a format tab, and gives each package full edit + soft-archive + restore.
 * This spec drives that surface end-to-end for BOTH formats:
 *
 *   1. Seed an approved brief + a posted launch package (image, then video).
 *   2. Open the package detail -> edit the operator notes -> assert persisted.
 *   3. Back on /launches, archive the package via the row action + confirm.
 *   4. It drops out of the active list and the DB `deleted_at` is set.
 *   5. Switch to the Archived view -> restore it.
 *   6. It returns to the active list and the DB `deleted_at` is cleared.
 *
 * Soft, reversible delete: we assert the tombstone is set after archive and
 * cleared after restore, mirroring pipeline-archive.spec.ts.
 */

type Format = "image" | "video";

const TABLES: Record<Format, "launch_packages" | "video_launch_packages"> = {
  image: "launch_packages",
  video: "video_launch_packages",
};

const DETAIL_PREFIX: Record<Format, string> = {
  image: "/launches",
  video: "/launches/video",
};

async function tombstone(format: Format, launchId: string): Promise<string | null> {
  const { data } = await getTestAdminClient()
    .from(TABLES[format])
    .select("deleted_at")
    .eq("id", launchId)
    .maybeSingle();
  return data?.deleted_at ?? null;
}

async function notesValue(format: Format, launchId: string): Promise<string | null> {
  const { data } = await getTestAdminClient()
    .from(TABLES[format])
    .select("decided_notes")
    .eq("id", launchId)
    .maybeSingle();
  return data?.decided_notes ?? null;
}

for (const format of ["image", "video"] as const) {
  test.describe(`unified launches manage (${format})`, () => {
    test(`edit -> archive -> restore a ${format} launch package`, async ({ page, clientId }) => {
      // Step 1. Seed an approved brief + a posted launch package.
      const briefId = await seedApprovedBrief(clientId, format);
      const launchId = await seedPushedLaunch(briefId, format);
      const admin = getTestAdminClient();
      const detailHref = `${DETAIL_PREFIX[format]}/${launchId}`;

      // Step 2. Edit the operator notes on the detail page.
      await page.goto(detailHref);
      await page.getByRole("button", { name: /edit notes/i }).click();
      await expect(page.getByRole("dialog")).toBeVisible();
      const note = `e2e edit ${Date.now()}`;
      await page.getByLabel(/notes/i).fill(note);
      await page.getByRole("button", { name: /^save$/i }).click();
      await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 15_000 });
      await expect.poll(async () => notesValue(format, launchId), { timeout: 15_000 }).toBe(note);

      // Step 3. Go to the unified list. The video format needs its tab.
      await page.goto("/launches");
      if (format === "video") {
        await page.getByRole("tab", { name: "Video" }).click();
      }

      const row = page.locator(`tr:has(a[href="${detailHref}"])`);
      await expect(row).toBeVisible({ timeout: 15_000 });

      // Step 4. Archive via the row "..." menu + confirm dialog.
      await row.getByRole("button", { name: /row actions/i }).click();
      await page.getByRole("menuitem", { name: /archive/i }).click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await page.getByRole("button", { name: /^archive$/i }).click();

      // It drops out of the active list ...
      await expect(page.locator(`tr:has(a[href="${detailHref}"])`)).toHaveCount(0, {
        timeout: 15_000,
      });
      // ... and the DB tombstone is set.
      await expect
        .poll(async () => tombstone(format, launchId), { timeout: 15_000 })
        .not.toBeNull();

      // Step 5. Switch to the Archived view; the row shows up with Restore.
      await page.getByRole("tab", { name: "Archived" }).click();
      if (format === "video") {
        // The format tab selection persists; make sure we're still on Video.
        await expect(page.getByRole("tab", { name: "Video", selected: true })).toBeVisible();
      }
      const archivedRow = page.locator(`tr:has(a[href="${detailHref}"])`);
      await expect(archivedRow).toBeVisible({ timeout: 15_000 });

      // Step 6. Restore via the row action.
      await archivedRow.getByRole("button", { name: /row actions/i }).click();
      await page.getByRole("menuitem", { name: /restore/i }).click();

      // It leaves the Archived view ...
      await expect(page.locator(`tr:has(a[href="${detailHref}"])`)).toHaveCount(0, {
        timeout: 15_000,
      });
      // ... and the DB tombstone is cleared.
      await expect.poll(async () => tombstone(format, launchId), { timeout: 15_000 }).toBeNull();
    });
  });
}
