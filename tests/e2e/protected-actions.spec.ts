import {
  test,
  expect,
  getTestAdminClient,
  seedApprovedBrief,
  seedCreative,
  seedPipeline,
} from "./_fixtures";

/**
 * Protected-artifact managed surfaces — happy path (M6 / #595 follow-up).
 *
 * The M6 milestone exposes the CORRECT corrective action for each protected
 * artifact (never a raw edit/delete). This spec drives the two actions that
 * have NO worker dependency, so they exercise the real Next.js routes + the
 * real Supabase end-to-end:
 *
 *   1. Compliance override: a hard compliance block is released via the
 *      existing pipeline override route (`/api/pipelines/[id]/compliance/override`)
 *      with a REQUIRED written justification. The failing finding is RETAINED
 *      (append-only audit); the override columns are stamped.
 *   2. Perf overlay edit: `campaign_perf_image` is worker-owned. The operator
 *      records a single-field correction via the `overrides` overlay
 *      (`/api/overrides`); the source perf row is NEVER touched.
 *
 * QA re-run + spec override are pipeline-scoped worker tools (the dev server
 * doesn't carry WORKER_URL in this e2e), so they are covered by unit tests +
 * the route-level contract tests instead.
 *
 * The fixture wipes pipelines + campaign_perf rows for the test client both
 * before and after the test, so we don't need to clean up `overrides` /
 * `compliance_finding` rows directly (they cascade through pipeline_id).
 */

test.describe("protected-artifact managed actions", () => {
  test("override compliance + correct perf via overrides overlay (never the source row)", async ({
    page,
    clientId,
  }) => {
    const admin = getTestAdminClient();

    // -----------------------------------------------------------------------
    // Step 1. Seed an approved brief + a creative + a pipeline.
    // -----------------------------------------------------------------------
    const briefId = await seedApprovedBrief(clientId, "image");
    const creativeId = await seedCreative(briefId, {
      concept: "Protected actions e2e",
      ratio: "1x1",
      status: "draft",
    });
    const pipelineId = await seedPipeline(clientId, { format_choice: "image" });
    // Flip directly to `monitor` so the page renders MonitorDashboard.
    // Silent-failure PR-4: `pipelines.status` was dropped (migration 0051);
    // we emit a `stage_advanced -> monitor` event so the reducer resolves
    // to monitor.
    {
      const { error } = await admin.from("pipeline_events").insert({
        pipeline_id: pipelineId,
        kind: "stage_advanced",
        stage: "monitor",
        payload: { seeded: true },
      } as never);
      if (error) throw new Error(`flip pipeline to monitor failed: ${error.message}`);
    }

    // Link the creative to the pipeline so the manage page can resolve it.
    {
      const { error } = await admin
        .from("creatives")
        .update({ pipeline_id: pipelineId } as never)
        .eq("id", creativeId);
      if (error) throw new Error(`link creative.pipeline_id failed: ${error.message}`);
    }

    // Seed the compliance stage state + a failing finding so the manage page
    // surfaces the Override action. Both tables have `as never` casts because
    // they are not in the generated types yet (the rebuild migration is on
    // main but the types regen lives in a sibling track).
    {
      const { error } = await admin.from("creative_stage_state" as never).insert({
        pipeline_id: pipelineId,
        creative_id: creativeId,
        stage: "compliance_review",
        status: "failed",
      } as never);
      if (error) throw new Error(`seed creative_stage_state failed: ${error.message}`);
    }
    {
      const { error } = await admin.from("compliance_finding" as never).insert({
        pipeline_id: pipelineId,
        creative_id: creativeId,
        pass: 1,
        rule_id: "FTC-SUBSTANTIATION",
        rule_version: 1,
        severity: "critical",
        verdict: "fail",
        citation_url: "https://example.test/ftc",
        checked_by: "worker",
      } as never);
      if (error) throw new Error(`seed compliance_finding failed: ${error.message}`);
    }

    // Seed a perf row in the monitor stage so MonitorDashboard renders an
    // editable overlay cell. `campaign_id` is the row label in the table.
    const campaignId = `t-m6-${Date.now()}`;
    let perfRowId: string;
    {
      const { data, error } = await admin
        .from("campaign_perf_image")
        .insert({
          client_id: clientId,
          pipeline_id: pipelineId,
          campaign_id: campaignId,
          window_days: 30,
          spend: 100,
          leads_ghl: 2,
          leads_meta: 3,
        })
        .select("id")
        .single();
      if (error || !data) throw new Error(`seed campaign_perf_image failed: ${error?.message}`);
      perfRowId = data.id;
    }

    // -----------------------------------------------------------------------
    // Step 2. Compliance override via the existing pipeline route.
    // -----------------------------------------------------------------------
    await page.goto(`/creatives/manage/${creativeId}`);
    await expect(page.getByRole("heading", { name: /Protected actions e2e/i })).toBeVisible();

    await page.getByTestId("compliance-override-open").click();
    await page.getByTestId("compliance-override-note").fill("E2E manager review: substantiated.");
    await page.getByTestId("compliance-override-submit").click();

    // The compliance_finding is retained but stamped overridden (append-only audit).
    await expect
      .poll(
        async () => {
          const { data } = await admin
            .from("compliance_finding" as never)
            .select("overridden, override_reason")
            .eq("creative_id" as never, creativeId as never)
            .maybeSingle();
          const row = (data ?? null) as { overridden?: boolean; override_reason?: string } | null;
          return row?.overridden ?? false;
        },
        { timeout: 15_000 },
      )
      .toBe(true);

    // The audit event row lands on pipeline_events (kind = 'compliance_overridden').
    await expect
      .poll(
        async () => {
          const { data } = await admin
            .from("pipeline_events")
            .select("id")
            .eq("pipeline_id", pipelineId)
            .eq("kind", "compliance_overridden");
          return data?.length ?? 0;
        },
        { timeout: 15_000 },
      )
      .toBeGreaterThan(0);

    // -----------------------------------------------------------------------
    // Step 3. Perf overlay edit via the overrides route (no source-row write).
    // -----------------------------------------------------------------------
    await page.goto(`/pipeline/${pipelineId}`);
    await expect(page.getByTestId("monitor-dashboard")).toBeVisible();
    await expect(page.getByTestId(`monitor-row-${campaignId}`)).toBeVisible();

    // Click the spend EditableValue, type a correction, commit on Enter. The
    // input replaces the button in-place once edit mode opens; we scope the
    // locator to the row so a future overlay editor in the leads column is
    // unambiguous.
    const row = page.getByTestId(`monitor-row-${campaignId}`);
    await row
      .getByRole("button", { name: new RegExp(`correct spend for ${campaignId}`, "i") })
      .click();
    const spendInput = row.locator('input[type="number"]').first();
    await spendInput.fill("150");
    await spendInput.press("Enter");

    // The corrected value is recorded via the overlay, keyed on the source row id.
    await expect
      .poll(
        async () => {
          const { data } = await admin
            .from("overrides")
            .select("corrected_value")
            .eq("table_name", "campaign_perf_image")
            .eq("row_id", perfRowId)
            .eq("field_name", "spend")
            .maybeSingle();
          return data?.corrected_value ?? null;
        },
        { timeout: 15_000 },
      )
      .toBe(150);

    // GUARDRAIL: the source perf row's spend is UNCHANGED — the overlay never
    // touches the worker-owned row.
    {
      const { data } = await admin
        .from("campaign_perf_image")
        .select("spend")
        .eq("id", perfRowId)
        .maybeSingle();
      expect(data?.spend).toBe(100);
    }

    // -----------------------------------------------------------------------
    // Cleanup the test overrides explicitly — the fixture doesn't cascade
    // `overrides` (it isn't FK-linked to pipelines / campaign_perf).
    // -----------------------------------------------------------------------
    await admin
      .from("overrides")
      .delete()
      .eq("table_name", "campaign_perf_image")
      .eq("row_id", perfRowId);
  });
});
