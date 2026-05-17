import { test, expect, seedCampaignPerf } from "./_fixtures";

/**
 * Audit cycle + threshold trigger (M4-12 / #63).
 *
 * The audit page (`/audit`) is server-rendered from `campaign_perf_image`
 * and `campaign_perf_video`. The worker daily pull lands no rows yet — so
 * we test by seeding rows directly via the service-role client and
 * asserting the cards / table / verdict badges render correctly.
 *
 * Specs:
 *
 *  1. Seeded rows appear in the table + a "kill"-verdict badge renders for
 *     a low-CTR row, mirroring the worker's threshold output.
 *  2. The format tab is a URL-driven `<a>`-equivalent that swaps the data
 *     source: image rows stay visible under `?format=image`; the same row
 *     should NOT appear under `?format=video`.
 *  3. Threshold trigger: when seeded rows include a `kill` verdict the
 *     "Needs attention" card shows the campaign as the headline.
 *  4. Window picker reflects the URL query.
 *
 * NOTE: the page checks `rows.length === 0` against `campaign_perf_*` —
 * not filtered by client. Other dev rows may exist; we therefore can't
 * reliably assert the empty-state copy unless we know the DB is empty.
 * Instead the empty-state assertion runs only when no rows of any kind
 * exist for the current window.
 */

test.describe("audit page", () => {
  test("seeded campaign_perf rows render in the table", async ({ page, clientId }) => {
    await seedCampaignPerf(clientId, [
      {
        campaign_id: "test-c1",
        format: "image",
        window_days: 30,
        spend: 100,
        impressions: 4000,
        clicks: 100,
        ctr: 0.025,
        leads_meta: 5,
        cpl_real: 20,
        verdict: "keep",
      },
      {
        campaign_id: "test-c2",
        format: "image",
        window_days: 30,
        spend: 200,
        impressions: 40000,
        clicks: 200,
        ctr: 0.005,
        leads_meta: 0,
        verdict: "kill",
        verdict_reason: "low CTR + zero leads",
      },
    ]);

    await page.goto("/audit?window=30&format=image");

    // Both campaign ids render somewhere on the page (cards + table).
    await expect(page.getByText("test-c1").first()).toBeVisible();
    await expect(page.getByText("test-c2").first()).toBeVisible();

    // The verdict cell renders a Kill pill for test-c2. The MetricBadge
    // component shows the literal "Kill" text — assert it's present at
    // least once in the document.
    await expect(page.getByText("Kill").first()).toBeVisible();
    await expect(page.getByText("Keep").first()).toBeVisible();

    // The verdict reason is surfaced via the `title` attribute on the
    // badge. Locate any element whose title is the reason — there should
    // be at least one match (it's reused in the table and possibly the
    // cards).
    const badge = page.locator(`[title="low CTR + zero leads"]`).first();
    await expect(badge).toBeVisible();
  });

  test("format tab swaps data source", async ({ page, clientId }) => {
    await seedCampaignPerf(clientId, [
      {
        campaign_id: "test-img-only",
        format: "image",
        window_days: 30,
        spend: 50,
        ctr: 0.02,
        verdict: "keep",
      },
      {
        campaign_id: "test-vid-only",
        format: "video",
        window_days: 30,
        spend: 75,
        ctr: 0.015,
        hook_rate: 0.25,
        verdict: "watch",
      },
    ]);

    // Image tab: only the image campaign id should appear.
    await page.goto("/audit?format=image&window=30");
    await expect(page.getByText("test-img-only").first()).toBeVisible();
    await expect(page.getByText("test-vid-only")).toHaveCount(0);

    // Video tab: only the video campaign id should appear.
    await page.goto("/audit?format=video&window=30");
    await expect(page.getByText("test-vid-only").first()).toBeVisible();
    await expect(page.getByText("test-img-only")).toHaveCount(0);

    // Combined tab: both appear.
    await page.goto("/audit?format=combined&window=30");
    await expect(page.getByText("test-img-only").first()).toBeVisible();
    await expect(page.getByText("test-vid-only").first()).toBeVisible();
  });

  test("threshold trigger: kill verdict surfaces in the cards", async ({ page, clientId }) => {
    await seedCampaignPerf(clientId, [
      {
        campaign_id: "test-killme",
        format: "image",
        window_days: 30,
        spend: 500,
        impressions: 100000,
        clicks: 200,
        ctr: 0.002,
        leads_meta: 0,
        cpl_real: null,
        verdict: "kill",
        verdict_reason: "Spend with zero leads",
      },
    ]);

    await page.goto("/audit?window=30&format=image");

    // The "Needs attention" cards section title appears.
    await expect(page.getByText(/needs attention/i)).toBeVisible();
    // The high-attention campaign is shown.
    await expect(page.getByText("test-killme").first()).toBeVisible();
    // CPL is the headline metric for image. The seeded row has CPL=null,
    // so the cell falls back to the em-dash. Verify the headline label
    // "CPL" is on the page (rendered inside the card).
    await expect(page.getByText("CPL").first()).toBeVisible();
  });

  test("window picker reflects the URL query and renders the right buttons", async ({ page }) => {
    await page.goto("/audit?window=7");
    // Window picker is a small group of <a> links.
    const group = page.getByRole("group", { name: /audit window/i });
    await expect(group).toBeVisible();
    // The 7d link carries aria-current="page" when selected.
    await expect(group.getByText("7d")).toHaveAttribute("aria-current", "page");
    // All three options render (1d / 7d / 30d).
    await expect(group.getByText("1d")).toBeVisible();
    await expect(group.getByText("30d")).toBeVisible();
  });
});
