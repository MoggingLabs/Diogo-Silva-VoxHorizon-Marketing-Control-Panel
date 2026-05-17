import { test, expect, seedApprovedBrief, seedCreative } from "./_fixtures";

/**
 * Image creative loop (M2-15 / #43).
 *
 * Exercises the seam between an approved brief and the variants grid /
 * side panel / decision API:
 *
 *   1. Pre-seed two creatives against an approved brief (the worker
 *      generation step is mocked here — the rows are inserted directly
 *      via the admin client). The grid should render both tiles.
 *   2. Open the side panel for one of them and approve it. The status
 *      pill in the panel should flip to "Approved" once the decision
 *      POST round-trips through `/api/creatives/:id/decision`.
 *   3. Reject path: seed one and click Reject (we dismiss the native
 *      confirm dialog only on the first attempt to verify the guard,
 *      then accept the second time and assert the status pill flips).
 *   4. State-machine guard: a non-draft creative cannot be re-decided.
 *      Hitting the decision API directly via `page.request` returns 409.
 *
 * NOTE: This spec does NOT depend on the worker being up. The creative
 * rows are seeded with `file_path_supabase = null`, which makes the
 * grid fall back to its "No render yet" placeholder tile. That keeps
 * the test fast and deterministic.
 */

test.describe("image creative loop", () => {
  test("approved brief → variants visible → approve a creative", async ({ page, clientId }) => {
    const briefId = await seedApprovedBrief(clientId, "image");
    await seedCreative(briefId, {
      concept: "Before-After Kitchen",
      ratio: "1x1",
      status: "draft",
    });
    await seedCreative(briefId, {
      concept: "Hero Bathroom",
      ratio: "9x16",
      status: "draft",
    });

    await page.goto(`/creatives/${briefId}`);

    // Both tiles should render. The concept lives in a truncated `<span>`
    // — getByText hits the truncated text node fine.
    await expect(page.getByText(/Before-After Kitchen/i).first()).toBeVisible();
    await expect(page.getByText(/Hero Bathroom/i).first()).toBeVisible();

    // Open the first creative's side panel. The grid tiles are
    // `<button>` elements (see CreativeCard.tsx), so clicking the concept
    // text bubbles up to the parent button.
    await page
      .getByText(/Before-After Kitchen/i)
      .first()
      .click();

    // The side panel slides in (Radix Sheet → a dialog role). Inside the
    // panel the Decision section has an emerald "Approve" button.
    const sidePanel = page.getByRole("dialog");
    await expect(sidePanel).toBeVisible();
    const approveBtn = sidePanel.getByRole("button", { name: /^approve$/i });
    await expect(approveBtn).toBeVisible();
    await approveBtn.click();

    // After the decision POST resolves the parent grid re-renders with
    // `status="approved"`. The side panel's status pill (next to the
    // SheetTitle) should show "Approved". `router.refresh()` fires after
    // the API responds — give the network round-trip a generous timeout.
    await expect(sidePanel.getByText(/^Approved$/).first()).toBeVisible({
      timeout: 15_000,
    });

    // The Decision section now reads "Decided …" instead of showing the
    // approve / reject buttons.
    await expect(sidePanel.getByRole("button", { name: /^approve$/i })).toHaveCount(0);
    await expect(sidePanel.getByRole("button", { name: /^reject$/i })).toHaveCount(0);
  });

  test("reject path: confirm-dialog guard + status pill flips", async ({ page, clientId }) => {
    const briefId = await seedApprovedBrief(clientId, "image");
    await seedCreative(briefId, {
      concept: "Reject Me",
      ratio: "1x1",
      status: "draft",
    });

    await page.goto(`/creatives/${briefId}`);
    await page
      .getByText(/Reject Me/i)
      .first()
      .click();

    const sidePanel = page.getByRole("dialog");
    await expect(sidePanel).toBeVisible();
    const rejectBtn = sidePanel.getByRole("button", { name: /^reject$/i });
    await expect(rejectBtn).toBeVisible();

    // First click: dismiss the confirm dialog → the creative stays draft.
    page.once("dialog", (d) => d.dismiss());
    await rejectBtn.click();
    // Status pill stays "Draft" — re-fetch from the side panel since the
    // panel header has its own pill.
    await expect(sidePanel.getByText(/^Draft$/).first()).toBeVisible();
    await expect(rejectBtn).toBeVisible();

    // Second click: accept the confirm → decision goes through.
    page.once("dialog", (d) => d.accept());
    await rejectBtn.click();
    await expect(sidePanel.getByText(/^Rejected$/).first()).toBeVisible({
      timeout: 15_000,
    });
  });

  test("decision API: non-draft creative returns 409", async ({ page, clientId }) => {
    const briefId = await seedApprovedBrief(clientId, "image");
    // Seed the row directly in `status = 'approved'` — the state machine
    // (see lib/creatives.ts:`allowedDecisions`) blocks any further
    // decision from this state.
    const creativeId = await seedCreative(briefId, {
      concept: "Already Approved",
      ratio: "1x1",
      status: "approved",
    });

    const res = await page.request.post(`/api/creatives/${creativeId}/decision`, {
      data: { decision: "reject" },
    });
    expect(res.status()).toBe(409);
    const body = (await res.json()) as { error?: string; current?: string };
    expect(body.error).toBe("invalid_state");
    expect(body.current).toBe("approved");
  });
});
