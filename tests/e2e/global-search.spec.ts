import { test, expect, getTestAdminClient, seedApprovedBrief, TEST_CLIENT_NAME } from "./_fixtures";

/**
 * Global command-palette search happy path (Makeover M7 efficiency layer).
 *
 * Drives the real `/api/search` aggregator end to end:
 *
 *   1. Seed a brief on the canonical test client so there is a known result row.
 *   2. Open the cmd-k palette via the global keyboard shortcut.
 *   3. Type a substring that matches the seeded brief id; assert that the live
 *      result group appears.
 *   4. Press Enter to deep-link to the result; the URL should land on the
 *      brief's detail page.
 *
 * The palette renders results from the `/api/search` route (no mocking) so this
 * exercises the entire wiring: keystroke -> debounced fetch -> grouped
 * `<CommandGroup>` -> deep-link router push.
 */

test.describe("global command-palette search", () => {
  test("cmd-k -> type -> deep-link to the matched resource", async ({ page, clientId }) => {
    // Seed a brief so its brief_id_human is searchable. The helper returns the
    // primary key; the human id is read back from the DB so the assertion uses
    // the live value rather than a guess.
    const briefId = await seedApprovedBrief(clientId, "image");
    const admin = getTestAdminClient();
    const { data: briefRow } = await admin
      .from("briefs")
      .select("brief_id_human")
      .eq("id", briefId)
      .maybeSingle();
    const briefHuman = briefRow?.brief_id_human ?? "";
    expect(briefHuman.length).toBeGreaterThan(0);

    // Land on any page; the palette + cmd-k handler live in the AppShell.
    await page.goto("/");

    // Open via the global shortcut (works on Linux/macOS/Windows test runners).
    const isMac = process.platform === "darwin";
    await page.keyboard.press(isMac ? "Meta+K" : "Control+K");

    const palette = page.getByRole("dialog");
    await expect(palette).toBeVisible({ timeout: 5_000 });

    // Type the brief id substring; results stream in via /api/search.
    const input = palette.getByPlaceholder(/search clients/i);
    await input.fill(briefHuman.slice(0, 6));

    // The Briefs group appears, with our seeded brief id inside it.
    await expect(palette.getByText("Briefs")).toBeVisible({ timeout: 10_000 });
    const briefItem = palette.getByText(briefHuman, { exact: true });
    await expect(briefItem).toBeVisible();

    // Activate the result -> palette closes + URL navigates to the brief.
    await briefItem.click();
    await expect(page).toHaveURL(new RegExp(`/briefs/${briefId}$`), { timeout: 10_000 });

    // The detail page renders and the seeded client name is reachable.
    await expect(page.getByText(TEST_CLIENT_NAME).first()).toBeVisible({ timeout: 15_000 });
  });

  test("empty query falls back to the navigation list", async ({ page }) => {
    await page.goto("/");
    const isMac = process.platform === "darwin";
    await page.keyboard.press(isMac ? "Meta+K" : "Control+K");
    const palette = page.getByRole("dialog");
    await expect(palette).toBeVisible();

    // With no query typed, the palette shows the nav list (Dashboard, Clients,
    // Briefs, ...) instead of `/api/search` results.
    await expect(palette.getByText("Navigate")).toBeVisible();
    await expect(palette.getByText("Dashboard")).toBeVisible();
    await expect(palette.getByText("Briefs")).toBeVisible();
  });
});
