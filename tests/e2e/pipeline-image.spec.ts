import { test, expect, getTestAdminClient, TEST_CLIENT_NAME } from "./_fixtures";
import { mockEkkoDraft, mockWorkerGeneration, mockWorkerIdeation } from "./_mocks/sse-harness";

/**
 * Pipeline image-only happy path (PF-G-3 / #204).
 *
 * Walks the full operator-driven slice of the pipeline from creation through
 * Configuration → Ideation → Review → Generation → Done. The Generation
 * auto-advance is driven by the SSE mock harness:
 *
 *   * The `pipeline_events_auto_advance_done_trg` DB trigger flips the
 *     pipeline forward when every `task_queued` is matched by a
 *     `task_done`. We seed those events directly via the harness
 *     (`tests/e2e/_mocks/`).
 *   * Ekko's draft SSE is intercepted via `page.route` and a canned
 *     `propose_config` payload is returned. The form hydrates from it.
 *
 * The Wave 13 scope (configuration → cancel) is preserved as a separate
 * `test()` so both the happy and cancel paths stay covered.
 */

test.describe("pipeline — image format", () => {
  test("create → configuration → cancel", async ({ page, clientId }) => {
    void clientId; // ensures the fixture upserts the client + cleans up pipelines

    // Step 1. Visit /pipeline/new. This server-component route creates a
    // pipeline with `format_choice='image'` and 302s to /pipeline/{id}.
    await page.goto("/pipeline/new");
    await expect(page).toHaveURL(/\/pipeline\/[a-f0-9-]{36}$/);

    // Step 2. Configuration stage is the first body — the header renders
    // a "Configuration" status badge.
    await expect(page.getByText("Configuration", { exact: true }).first()).toBeVisible();

    // The Image format radio should be preselected (the create route
    // defaults to format='image').
    const formatImageRadio = page.locator("#fmt-image");
    await expect(formatImageRadio).toBeVisible();

    // Step 3. Client picker is server-fetched and should include our test
    // client. Pick it; this fires an autosave PATCH to /api/pipelines/{id}/config.
    const clientTrigger = page.locator("#stage-config-client");
    await expect(clientTrigger).toBeEnabled();
    await clientTrigger.click();
    await page.getByRole("option", { name: new RegExp(TEST_CLIENT_NAME, "i") }).click();

    // Step 4. Cancel button should be visible in the header — non-terminal
    // status. It's the operator's escape hatch from the Configuration stage
    // before any worker spend.
    const cancelBtn = page.getByRole("button", { name: /cancel pipeline/i });
    await expect(cancelBtn).toBeVisible();

    // Step 5. Click cancel; the confirmation modal opens with the
    // destructive "Cancel pipeline" action.
    await cancelBtn.click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByRole("heading", { name: /cancel this pipeline\?/i })).toBeVisible();

    const confirmBtn = page.getByRole("button", { name: /^cancel pipeline$/i }).last();
    await confirmBtn.click();

    // Step 6. After cancel the page refreshes with status='cancelled'.
    await expect(page.getByText("Cancelled", { exact: true })).toBeVisible({ timeout: 15_000 });
    // Cancellation banner replaces the stepper.
    await expect(page.getByText(/this pipeline was cancelled/i)).toBeVisible();
    // Cancel button is gone on the terminal stage.
    await expect(page.getByRole("button", { name: /cancel pipeline/i })).toHaveCount(0);
  });

  test("ideation empty state renders when no variants exist", async ({ page, clientId }) => {
    void clientId;

    // Pipelines arrive at Ideation only after a successful configure→advance
    // round trip; that requires a valid image brief in `config_draft` plus a
    // server insert that mints the brief row. Driving the full UI path is
    // covered in unit tests; here we just need *a* pipeline whose `briefId`
    // is null so the empty state renders.
    await page.goto("/pipeline/new");
    await expect(page).toHaveURL(/\/pipeline\/[a-f0-9-]{36}$/);

    // The Configuration stage is the entry point; verify the body renders
    // the Image brief fieldset (the active track for format=image).
    await expect(page.getByText(/image brief/i)).toBeVisible();
    await expect(page.getByLabel(/^market$/i)).toBeVisible();
    await expect(page.getByLabel(/total budget/i)).toBeVisible();

    // The cost-table doesn't render until Review stage. Verify the
    // Configuration subtitle is rendered (it documents the autosave behaviour).
    await expect(page.getByText(/autosaves as you go/i)).toBeVisible();
  });

  test("full happy path: configuration → ideation → review → generation → done", async ({
    page,
    clientId,
  }) => {
    void clientId;

    // -----------------------------------------------------------------
    // Step 1. Create a new pipeline (defaults to format='image').
    // -----------------------------------------------------------------
    await page.goto("/pipeline/new");
    await expect(page).toHaveURL(/\/pipeline\/[a-f0-9-]{36}$/);
    const url = page.url();
    const pipelineId = url.match(/\/pipeline\/([a-f0-9-]{36})$/)?.[1];
    if (!pipelineId) throw new Error(`could not extract pipeline id from ${url}`);

    // -----------------------------------------------------------------
    // Step 2. Configure: pick client + fill image brief.
    // -----------------------------------------------------------------
    const clientTrigger = page.locator("#stage-config-client");
    await expect(clientTrigger).toBeEnabled();
    await clientTrigger.click();
    await page.getByRole("option", { name: new RegExp(TEST_CLIENT_NAME, "i") }).click();

    // Select "Remodeling" — matches the seeded test client's service_type.
    await page.getByLabel("Remodeling", { exact: true }).click();

    await page.getByLabel(/^market$/i).fill("Austin, TX");
    await page.getByLabel(/total budget/i).fill("5000");
    await page.getByLabel(/landing page url/i).fill("https://example.com/lp");
    // Add an offer so the brief is rich enough for downstream stages.
    await page.getByLabel(/^offer$/i).fill("Free roof inspection");

    // Wait for autosave to settle — the form debounces at 1s so an extra
    // beat ensures the PATCH lands before we trigger the advance.
    await expect(page.getByText("Saved", { exact: true })).toBeVisible({ timeout: 15_000 });

    // -----------------------------------------------------------------
    // Step 3. Advance to Ideation. The Continue button is gated on a
    //         valid brief — after the autosave it should be enabled.
    // -----------------------------------------------------------------
    const continueBtn = page.getByRole("button", { name: /continue to ideation/i });
    await expect(continueBtn).toBeEnabled();
    await continueBtn.click();

    // The advance route updates `status='ideation'` and stamps
    // `image_brief_id`; the page refreshes server-side.
    await expect(page.getByText("Ideation", { exact: true }).first()).toBeVisible({
      timeout: 15_000,
    });

    // -----------------------------------------------------------------
    // Step 4. Seed ideation variants — the worker isn't running so
    //         StageIdeation would otherwise stay empty.
    // -----------------------------------------------------------------
    const seeded = await mockWorkerIdeation(page, { pipelineId, n: 4 });
    expect(seeded.image).toHaveLength(4);

    // Wait for the cards to render via realtime; the StageIdeation grid
    // subscribes to `creatives` filtered by brief_id. The "Picked: X of Y"
    // counter in the column header reflects total card count once the
    // grid has rendered.
    await expect(page.getByText(/Picked:\s*0\s*of\s*4/)).toBeVisible({ timeout: 15_000 });

    // -----------------------------------------------------------------
    // Step 5. Pick two image variants.
    // -----------------------------------------------------------------
    const pickedIds = [seeded.image[0]!.id, seeded.image[1]!.id];
    const pickButtons = page.getByRole("checkbox", { name: /pick concept/i });
    // Click the first two checkbox-styled cards. The order in `seeded`
    // matches the insert order, which matches the card render order
    // (the grid sorts by created_at asc).
    await pickButtons.nth(0).click();
    await pickButtons.nth(1).click();
    // Picked counter should reflect both selections — the StageShell
    // subtitle renders "Image: 2 picked" once the toggles land.
    await expect(page.getByText(/Image:\s*2\s*picked/)).toBeVisible();

    // -----------------------------------------------------------------
    // Step 6. Advance Ideation → Review.
    // -----------------------------------------------------------------
    const reviewCta = page.getByRole("button", { name: /continue to review/i });
    await expect(reviewCta).toBeEnabled();
    await reviewCta.click();
    await expect(page.getByText("Review", { exact: true }).first()).toBeVisible({
      timeout: 15_000,
    });

    // The Review stage renders the picks summary + cost table.
    await expect(page.getByText(/image picks/i)).toBeVisible();
    await expect(page.getByText(/cost forecast/i)).toBeVisible();

    // -----------------------------------------------------------------
    // Step 7. Approve. The decision route flips status='generation'.
    // -----------------------------------------------------------------
    await page.getByRole("button", { name: /^approve$/i }).click();
    await expect(page.getByText("Generation", { exact: true }).first()).toBeVisible({
      timeout: 15_000,
    });

    // -----------------------------------------------------------------
    // Step 8. Drive the generation chain via the harness — the DB
    //         trigger auto-advances `generation → done` on the last
    //         task_done.
    // -----------------------------------------------------------------
    await mockWorkerGeneration(page, {
      pipelineId,
      picks: { image: pickedIds },
    });

    // The trigger flips the row to `done` server-side. The detail
    // page's Realtime listener picks up the `pipelines` UPDATE and
    // calls `router.refresh()`; we also poll cost every 4s so the
    // refresh should land within ~5s.
    await expect(page.getByText("Done", { exact: true }).first()).toBeVisible({
      timeout: 20_000,
    });

    // Verify the post-update derived status is 'done' server-side too.
    // Silent-failure PR-4: `pipelines.status` was dropped (migration 0051);
    // the canonical answer comes from `compute_pipeline_status(id)`.
    const admin = getTestAdminClient();
    const { data: derivedStatus } = await admin.rpc("compute_pipeline_status", {
      p_pipeline_id: pipelineId,
    });
    expect(derivedStatus).toBe("done");

    // -----------------------------------------------------------------
    // Step 9. Done stage assertions — gallery + launch CTA visible.
    // -----------------------------------------------------------------
    // Image finals heading.
    await expect(page.getByText(/image finals/i)).toBeVisible();
    // The launch handoff section + CTA. Two finals per pick × 2 picks = 4
    // creatives — they'll group into 2 concept buckets.
    await expect(page.getByRole("button", { name: /build launch package/i })).toBeVisible();
  });
});

test.describe("pipeline — image format — Ekko draft mock", () => {
  test("Ekko proposal hydrates the form via SSE mock", async ({ page, clientId }) => {
    void clientId;

    await page.goto("/pipeline/new");
    await expect(page).toHaveURL(/\/pipeline\/[a-f0-9-]{36}$/);
    const url = page.url();
    const pipelineId = url.match(/\/pipeline\/([a-f0-9-]{36})$/)?.[1];
    if (!pipelineId) throw new Error(`could not extract pipeline id from ${url}`);

    // Mock Ekko's draft endpoint before the operator opens the modal —
    // the propose_config result will hydrate the form fields.
    await mockEkkoDraft(page, {
      pipelineId,
      proposedConfig: {
        format_choice: "image",
        image_payload: {
          service: "remodeling",
          market: "Phoenix, AZ",
          budget: 3500,
          landing_page_url: "https://example.com/phx-lp",
          offer_text: "Spring remodeling sale",
        },
        notes: "Filled by Ekko — review and edit before continuing.",
      },
    });

    await page.getByRole("button", { name: /let ekko draft this/i }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    // Send any message to trigger the SSE fetch — the harness replies
    // immediately with the canned propose_config payload.
    await page.getByPlaceholder(/type your answer/i).fill("Roofing in Phoenix, $3500 budget.");
    await page.getByRole("button", { name: /send to ekko/i }).click();

    // Confirmation banner appears once the proposal lands.
    await expect(page.getByText(/draft delivered/i)).toBeVisible({ timeout: 10_000 });
    // Close the modal — the form should have hydrated.
    await page.getByRole("button", { name: /review draft|cancel/i }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);

    // The hydrated market value should appear in the input.
    await expect(page.getByLabel(/^market$/i)).toHaveValue("Phoenix, AZ");
    await expect(page.getByLabel(/total budget/i)).toHaveValue("3500");
  });
});
