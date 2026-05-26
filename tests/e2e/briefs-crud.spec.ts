import { test, expect, getTestAdminClient, seedApprovedBrief, type BriefFormat } from "./_fixtures";

/**
 * Unified Briefs CRUD happy path (Makeover M3 / E3.1-E3.2, #590/#591).
 *
 * Exercises the operator's full control over a brief from the unified list +
 * detail:
 *
 *   1. Seed a brief for the test client (image, then a video case).
 *   2. It shows in the unified active list (/briefs) under the right format tab.
 *   3. Open the detail page, EDIT it via the drawer, and assert the change.
 *   4. ARCHIVE it from the detail header -> it leaves the active list and the
 *      DB tombstone (`deleted_at`, migration 0049) is set.
 *   5. From the archived view, RESTORE it -> it returns to the active list and
 *      the tombstone is cleared.
 *
 * Archive is a soft, reversible delete, so we assert the DB `deleted_at` flips
 * both ways rather than trusting the UI alone.
 */

function detailHref(format: BriefFormat, id: string): string {
  return format === "video" ? `/briefs/video/${id}` : `/briefs/${id}`;
}

test.describe("unified briefs CRUD", () => {
  test("image: list -> edit -> archive -> restore", async ({ page, clientId }) => {
    const briefId = await seedApprovedBrief(clientId, "image");
    const admin = getTestAdminClient();
    const href = detailHref("image", briefId);

    // Step 1. The brief shows in the unified active list (default = All tab).
    await page.goto("/briefs");
    const row = page.locator(`tr:has(a[href="${href}"])`);
    await expect(row).toBeVisible({ timeout: 15_000 });

    // Step 2. Open the detail page and EDIT the payload via the drawer.
    await page.goto(href);
    await page.getByRole("button", { name: /^edit$/i }).click();
    const drawer = page.getByRole("dialog");
    await expect(drawer).toBeVisible();
    const market = drawer.getByLabel(/^market$/i);
    await market.fill("Reno, NV");
    await drawer.getByRole("button", { name: /^save$/i }).click();

    // The edit persists (drawer closes, the new market shows on the page).
    await expect(page.getByRole("heading", { name: "Reno, NV" })).toBeVisible({ timeout: 15_000 });

    // Step 3. ARCHIVE from the header (confirm dialog).
    await page.getByRole("button", { name: /archive brief/i }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.getByRole("button", { name: /^archive$/i }).click();

    // The DB tombstone is set.
    await expect
      .poll(
        async () => {
          const { data } = await admin
            .from("briefs")
            .select("deleted_at")
            .eq("id", briefId)
            .maybeSingle();
          return data?.deleted_at ?? null;
        },
        { timeout: 15_000 },
      )
      .not.toBeNull();

    // Step 4. It is gone from the active list ...
    await page.goto("/briefs");
    await expect(page.locator(`tr:has(a[href="${href}"])`)).toHaveCount(0, { timeout: 15_000 });

    // ... and present in the archived view.
    await page.goto("/briefs?archived=1");
    const archivedRow = page.locator(`tr:has(a[href="${href}"])`);
    await expect(archivedRow).toBeVisible({ timeout: 15_000 });

    // Step 5. RESTORE it from the row action menu.
    await archivedRow.getByRole("button", { name: /row actions/i }).click();
    await page.getByRole("menuitem", { name: /restore/i }).click();

    // The DB tombstone is cleared.
    await expect
      .poll(
        async () => {
          const { data } = await admin
            .from("briefs")
            .select("deleted_at")
            .eq("id", briefId)
            .maybeSingle();
          return data?.deleted_at ?? null;
        },
        { timeout: 15_000 },
      )
      .toBeNull();

    // Back in the active list it is present again.
    await page.goto("/briefs");
    await expect(page.locator(`tr:has(a[href="${href}"])`)).toBeVisible({ timeout: 15_000 });
  });

  test("video: list -> archive -> restore from detail", async ({ page, clientId }) => {
    const briefId = await seedApprovedBrief(clientId, "video");
    const admin = getTestAdminClient();
    const href = detailHref("video", briefId);

    // The video brief shows in the unified list under the Video tab.
    await page.goto("/briefs");
    await page.getByRole("tab", { name: "Video" }).click();
    await expect(page.locator(`tr:has(a[href="${href}"])`)).toBeVisible({ timeout: 15_000 });

    // Archive from the detail header.
    await page.goto(href);
    await page.getByRole("button", { name: /archive brief/i }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.getByRole("button", { name: /^archive$/i }).click();

    await expect
      .poll(
        async () => {
          const { data } = await admin
            .from("video_briefs")
            .select("deleted_at")
            .eq("id", briefId)
            .maybeSingle();
          return data?.deleted_at ?? null;
        },
        { timeout: 15_000 },
      )
      .not.toBeNull();

    // Restore it from the archived detail page (the page stays on the brief).
    await page.goto(href);
    await page.getByRole("button", { name: /restore brief/i }).click();

    await expect
      .poll(
        async () => {
          const { data } = await admin
            .from("video_briefs")
            .select("deleted_at")
            .eq("id", briefId)
            .maybeSingle();
          return data?.deleted_at ?? null;
        },
        { timeout: 15_000 },
      )
      .toBeNull();
  });
});
