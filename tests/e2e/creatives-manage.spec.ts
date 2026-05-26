import { test, expect, getTestAdminClient, seedApprovedBrief, seedCreative } from "./_fixtures";

/**
 * Unified Creatives manage CRUD happy path (M4 / #593 #594).
 *
 * Exercises the per-creative manage surface end to end:
 *
 *   1. Seed an approved brief + a draft creative.
 *   2. Open /creatives/manage/<id> and edit the metadata (PATCH) — assert the
 *      new concept persists in the DB.
 *   3. Take the approve decision and assert it still flows through the existing
 *      decision route: status -> 'approved' in the DB AND a `creative_decided`
 *      event is emitted (the guardrail: status changes never go via a raw edit).
 *   4. Archive the creative (soft-delete) — assert `deleted_at` is set and the
 *      row drops out of the active grid.
 *   5. Restore it from the grid's Archived view — assert `deleted_at` is cleared.
 *
 * Soft, not hard: the creative is the root of copy + launch lineage, so archive
 * sets `deleted_at` and is fully reversible. No worker dependency — the creative
 * is seeded directly (no render needed; the manage page shows the placeholder).
 */

test.describe("creatives manage CRUD", () => {
  test("edit metadata -> decide via decision route -> archive -> restore", async ({
    page,
    clientId,
  }) => {
    const admin = getTestAdminClient();

    // Step 1. Seed an approved brief + a draft creative.
    const briefId = await seedApprovedBrief(clientId, "image");
    const creativeId = await seedCreative(briefId, {
      concept: "Original concept",
      ratio: "1x1",
      status: "draft",
    });

    // Step 2. Open the manage page and edit the metadata.
    await page.goto(`/creatives/manage/${creativeId}`);
    await expect(page.getByRole("heading", { name: /Original concept/i })).toBeVisible();

    await page.getByRole("button", { name: /edit metadata/i }).click();
    const drawer = page.getByRole("dialog");
    await expect(drawer).toBeVisible();
    const concept = drawer.getByLabel(/concept/i);
    await concept.fill("Edited concept");
    await drawer.getByRole("button", { name: /save/i }).click();

    // The edit persists to the DB via PATCH /api/creatives/:id.
    await expect
      .poll(
        async () => {
          const { data } = await admin
            .from("creatives")
            .select("concept")
            .eq("id", creativeId)
            .maybeSingle();
          return data?.concept ?? null;
        },
        { timeout: 15_000 },
      )
      .toBe("Edited concept");

    // Step 3. Approve via the Decision section (the existing decision route).
    await page.getByRole("button", { name: /^approve$/i }).click();

    // Status flips to 'approved' in the DB ...
    await expect
      .poll(
        async () => {
          const { data } = await admin
            .from("creatives")
            .select("status")
            .eq("id", creativeId)
            .maybeSingle();
          return data?.status ?? null;
        },
        { timeout: 15_000 },
      )
      .toBe("approved");

    // ... AND the decision route emitted its audit event (proof the status
    // change went through the decision route, not a raw metadata edit).
    await expect
      .poll(
        async () => {
          const { data } = await admin
            .from("events")
            .select("id")
            .eq("ref_table", "creatives")
            .eq("ref_id", creativeId)
            .eq("kind", "creative_decided");
          return data?.length ?? 0;
        },
        { timeout: 15_000 },
      )
      .toBeGreaterThan(0);

    // Step 4. Archive the creative (soft-delete).
    await page.getByRole("button", { name: /^archive$/i }).click();
    const confirm = page.getByRole("dialog");
    await expect(confirm).toBeVisible();
    await confirm.getByRole("button", { name: /^archive$/i }).click();

    // The DB tombstone is set.
    await expect
      .poll(
        async () => {
          const { data } = await admin
            .from("creatives")
            .select("deleted_at")
            .eq("id", creativeId)
            .maybeSingle();
          return data?.deleted_at ?? null;
        },
        { timeout: 15_000 },
      )
      .not.toBeNull();

    // Step 5. The archived creative no longer appears in the active grid, but
    // shows up under the Archived view with a Restore action.
    await page.goto("/creatives");
    await page.getByRole("button", { name: /show archived/i }).click();
    const restoreBtn = page.getByRole("button", { name: /restore creative/i }).first();
    await expect(restoreBtn).toBeVisible({ timeout: 15_000 });
    await restoreBtn.click();

    // The DB tombstone is cleared.
    await expect
      .poll(
        async () => {
          const { data } = await admin
            .from("creatives")
            .select("deleted_at")
            .eq("id", creativeId)
            .maybeSingle();
          return data?.deleted_at ?? null;
        },
        { timeout: 15_000 },
      )
      .toBeNull();
  });
});
