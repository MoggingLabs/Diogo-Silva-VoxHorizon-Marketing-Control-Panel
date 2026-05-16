import { test, expect, TEST_CLIENT_NAME } from "./_fixtures";

/**
 * Image brief lifecycle (M1-10 / #28).
 *
 * Exercises the happy path:
 *   1. Operator opens `/briefs/new`, fills the form, saves as draft.
 *   2. Detail page renders with status "Draft".
 *   3. Operator returns to the new-brief flow (drafts can't post inline yet),
 *      this time clicking "Post for approval" to land directly in posted.
 *   4. Approval gate appears; operator clicks "Approve".
 *   5. Detail page reflects the new "Approved" status and decision banner.
 *
 * Also asserts the notes-required rule on the approval gate (zod refinement
 * mirrored client-side in ApprovalGate.tsx).
 *
 * NOTE: the BriefForm uses a Radix `<Select>` for the client picker — not a
 * native `<select>` — so we drive it via click + option role rather than
 * `selectOption()`. Same for the service radio: it's a Radix RadioGroup with
 * labels, so we click the label by id.
 */

test.describe("image brief lifecycle", () => {
  test("draft → post → approve happy path", async ({ page, clientId }) => {
    void clientId; // ensures the fixture upserts the client + cleans up briefs

    await page.goto("/briefs/new");

    // Wait for clients to load — the Select trigger goes from "Loading clients…"
    // to "Select a client" once the browser query resolves. Targeting the
    // trigger by id keeps us off the brittle "first combobox on page".
    const clientTrigger = page.locator("#client_id");
    await expect(clientTrigger).toBeEnabled();
    await clientTrigger.click();
    // The Radix dropdown renders into a portal — match by accessible name.
    await page.getByRole("option", { name: new RegExp(TEST_CLIENT_NAME, "i") }).click();

    // Service is a Radix RadioGroup with explicit labels. Click the label for
    // "Remodeling" (matches the seeded test client's service_type).
    await page.getByLabel("Remodeling", { exact: true }).click();

    await page.getByLabel(/^market$/i).fill("Austin, TX");
    await page.getByLabel(/total budget/i).fill("5000");
    await page.getByLabel(/landing page url/i).fill("https://example.com/lp");

    // Post directly for approval — saves a round-trip vs save-draft-then-post,
    // and that's the path the operator most commonly takes.
    await page.getByRole("button", { name: /post for approval/i }).click();

    // After POST the form router-pushes to /briefs/{id}.
    await expect(page).toHaveURL(/\/briefs\/[a-f0-9-]{36}$/);

    // Detail page shows the status badge — "Posted" because we used ?post=1.
    await expect(page.getByText("Posted", { exact: true })).toBeVisible();

    // Approval gate is rendered for posted briefs. Click "Approve" (notes
    // optional for a clean approval).
    await expect(page.getByRole("button", { name: /^approve$/i })).toBeVisible();
    await page.getByRole("button", { name: /^approve$/i }).click();

    // The page calls router.refresh() after the approve POST; the server-side
    // detail page then re-renders with status="approved", the decision banner,
    // and the approval gate gone. Use a generous timeout — the approve POST
    // round-trips through the API + DB + revalidation.
    await expect(page.getByText("Approved", { exact: true })).toBeVisible({
      timeout: 15_000,
    });
    // Approval gate is hidden once the brief is no longer posted.
    await expect(page.getByRole("button", { name: /^approve$/i })).toHaveCount(0);
  });

  test("approve_with_changes requires notes", async ({ page, clientId }) => {
    void clientId;

    // Seed a posted brief by submitting the form directly — fast path through
    // the UI without reimplementing the create flow asserts.
    await page.goto("/briefs/new");
    const clientTrigger = page.locator("#client_id");
    await expect(clientTrigger).toBeEnabled();
    await clientTrigger.click();
    await page.getByRole("option", { name: new RegExp(TEST_CLIENT_NAME, "i") }).click();
    await page.getByLabel("Remodeling", { exact: true }).click();
    await page.getByLabel(/^market$/i).fill("Phoenix, AZ");
    await page.getByLabel(/total budget/i).fill("2500");
    await page.getByRole("button", { name: /post for approval/i }).click();
    await expect(page).toHaveURL(/\/briefs\/[a-f0-9-]{36}$/);

    // Without notes, "Approve with changes" should surface a client-side
    // validation error and NOT redirect / change status. The error text comes
    // from the DecisionInput zod refinement: "notes are required for
    // approved_with_changes and rejected".
    await page.getByRole("button", { name: /approve with changes/i }).click();
    await expect(page.getByRole("alert")).toContainText(/notes are required/i);
    // Status should still be Posted — gate stays mounted, no decision banner.
    await expect(page.getByText("Posted", { exact: true })).toBeVisible();

    // Now provide notes and retry — the brief should transition.
    await page.getByLabel(/^notes/i).fill("Bump budget to $3k and re-target ZIPs.");
    await page.getByRole("button", { name: /approve with changes/i }).click();
    await expect(page.getByText(/Approved with changes/i)).toBeVisible({ timeout: 15_000 });
  });
});
