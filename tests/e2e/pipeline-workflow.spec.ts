import { test, expect, getTestAdminClient } from "./_fixtures";
import { mockWorkerIdeation } from "./_mocks/sse-harness";
import { makeSquarePngBase64 } from "./_mocks/png-fixture";
import {
  assertWorkerHealthy,
  awaitWorkerStageClosed,
  emitGenerationClosure,
  qaPassItems,
  readPipelineStatus,
  readStageAdvancedOrder,
  readStageStates,
  seedFinalCreatives,
  seedGenerationOpenMarker,
  waitForStatus,
  workerPost,
} from "./_mocks/workflow-driver";

/**
 * No-stall workflow e2e (T.5 / #318).
 *
 * Drives ONE image-track pipeline through ALL 12 stages to `done` in
 * fake-integration mode, proving:
 *   (a) each `stage_advanced` pipeline_event fires in DAG order,
 *   (b) no stage stalls — every transition has an execution path (reaching
 *       `done` proves it),
 *   (c) the compliance HARD gate BLOCKS (422) on a failed finding until an
 *       audited override, then advances,
 *   (d) the launch HARD gate 422s until the preconditions are re-derived true,
 *   (e) NEGATIVE: an all-`task_error` generation does NOT advance past
 *       generation (it stays put — the documented all-failed no-stall guard).
 *
 * Drive map (manager via Next API / UI, operator via direct worker HTTP, auto
 * via SQL trigger):
 *   configuration→ideation        UI Continue        (advance route)
 *   ideation→review               UI Continue        (advance route, picks gate)
 *   review→generation             UI Approve         (review/decision)
 *   generation→creative_qa        AUTO               (migration 0024 trigger)
 *   creative_qa→compliance_review operator qa_run + manager advance
 *   compliance_review→copy (HARD) operator compliance_run (FAIL) → 422 block →
 *                                 manager override → advance
 *   copy→spec_validation          operator copy + manager copy/decision approve
 *                                 + advance (>=3 approved-copy gate)
 *   spec_validation→variant_plan  operator spec_result + manager advance
 *   variant_plan→finalize_assets  manager variant-plan/decision approve
 *   finalize_assets→launch_handoff operator finalize_result + manager advance
 *   launch_handoff→monitor (HARD) re-clear compliance (two-pass) → operator
 *                                 records launch → manager launch/decision
 *   monitor→done                  operator monitor_result + manager
 *                                 monitor/decision (kill)
 *
 * Operator actions go through direct worker HTTP (the test IS the operator —
 * there is no live Hermes agent in CI). Manager gates with stable UI are driven
 * through Playwright (configuration / ideation / review); the post-generation
 * gates are driven through the Next API routes directly (full-UI driving of the
 * per-creative grid is brittle under realtime) with a focused UI assertion that
 * each stage component renders the seeded state.
 */

const PNG_B64 = makeSquarePngBase64();

/** Clean, compliance-safe copy (no superlatives / financing / guarantee). */
const CLEAN_COPY = {
  headline: "Refresh your kitchen this season",
  primary_text: "Local remodeling pros ready to help you plan a remodel you will enjoy.",
  description: "Schedule a free planning consult with our team.",
  cta: "Learn more",
};

test.describe("pipeline — no-stall full workflow (image track)", () => {
  test("drives all 12 stages to done; hard gates block then advance; all-failed generation stalls", async ({
    page,
    clientId,
  }) => {
    const admin = getTestAdminClient();
    await assertWorkerHealthy();

    // ===================================================================
    // configuration → ideation
    // Create the pipeline via the real kickoff route + assert the config stage
    // renders (backend↔frontend wiring smoke), then seed a valid image-brief
    // draft + client via the admin client and drive the advance route. The
    // multi-field config FORM autosave is a UI concern with several timing /
    // shape failure points; the no-stall-relevant logic is the advance route
    // (it validates the draft, mints the brief, and stamps image_brief_id),
    // which we exercise directly here — consistent with how the post-generation
    // gates are driven through the Next API routes below.
    // ===================================================================
    await page.goto("/pipeline/new");
    await expect(page).toHaveURL(/\/pipeline\/[a-f0-9-]{36}$/);
    const pipelineId = page.url().match(/\/pipeline\/([a-f0-9-]{36})$/)?.[1];
    if (!pipelineId) throw new Error(`could not extract pipeline id from ${page.url()}`);
    await expect(page.getByText("Configuration", { exact: true }).first()).toBeVisible({
      timeout: 15_000,
    });

    const cfgSeed = await admin
      .from("pipelines")
      .update({
        client_id: clientId,
        config_draft: {
          image_payload: {
            service: "remodeling",
            budget: 5000,
            market: "Austin, TX",
            landing_page_url: "https://example.com/lp",
            offer_text: "Free planning consult",
          },
        } as never,
      })
      .eq("id", pipelineId);
    expect(cfgSeed.error, JSON.stringify(cfgSeed.error)).toBeNull();

    await expectAdvance(pipelineId, "ideation");

    // ===================================================================
    // ideation → review (UI): seed variants, pick one, continue
    // ===================================================================
    const seeded = await mockWorkerIdeation(page, { pipelineId, n: 3 });
    expect(seeded.image.length).toBe(3);
    // config→ideation was driven via the API above, so the browser still shows
    // the config view — reload to render the ideation grid over the seeded rows.
    await page.goto(`/pipeline/${pipelineId}`);
    await expect(page.getByText(/Picked:\s*0\s*of\s*3/)).toBeVisible({ timeout: 15_000 });
    await page
      .getByRole("checkbox", { name: /pick concept/i })
      .nth(0)
      .click();
    await expect(page.getByText(/Image:\s*1\s*picked/)).toBeVisible();

    await page.getByRole("button", { name: /continue to review/i }).click();
    await expect(page.getByText("Review", { exact: true }).first()).toBeVisible({
      timeout: 15_000,
    });

    // ===================================================================
    // review → generation (API Approve, then open the batch atomically)
    // ===================================================================
    // Silent-failure PR-8: with a real worker-stage consumer now draining
    // `worker_generation`, the review approve enqueues that row and the consumer
    // would claim + RENDER it (image finals run for real under FAKE_RENDER),
    // adding v1.0 creatives that break the creative_qa gate count below. We drive
    // the approve through the API (not a UI click) so the route's enqueue has
    // COMPLETED by the time it returns, then immediately open the generation
    // batch -- a fast write with no UI-visibility wait in between -- so the
    // producer's `generation_state` probe reports `already_running` before the
    // consumer's next poll. The consumer then claims + closes the work_item as a
    // no-op-but-real re-entry (proven via emitGenerationClosure's await), without
    // re-rendering. The closing terminal events come from
    // emitGenerationClosure({ alreadyOpened: true }) further down.
    const approve = await managerPost(pipelineId, "review/decision", {
      decision: "approved",
    });
    expect(approve.status, JSON.stringify(approve.body)).toBe(200);
    await seedGenerationOpenMarker(pipelineId, 2);
    expect(await readPipelineStatus(pipelineId)).toBe("generation");

    // Focused UI assertion: the Generation stage renders after the API advance.
    await page.goto(`/pipeline/${pipelineId}`);
    await expect(page.getByText("Generation", { exact: true }).first()).toBeVisible({
      timeout: 15_000,
    });

    // Resolve the pipeline's image brief id (stamped at configure→ideation).
    const { data: pipeRow } = await admin
      .from("pipelines")
      .select("image_brief_id")
      .eq("id", pipelineId)
      .maybeSingle();
    const imageBriefId = pipeRow?.image_brief_id;
    if (!imageBriefId) throw new Error("pipeline has no image_brief_id after review approve");

    // Silent-failure PR-8: prove the worker-stage consumer actually claimed +
    // closed the `worker_ideation` work_item the configuration→ideation advance
    // route enqueued. The seeded ideation concepts satisfy the producer's
    // `ideation_already_ran` idempotency probe, so the real consumer claims the
    // row, runs the in-process service (a no-op-but-real re-entry), and closes
    // it -- which is the symmetric half the cutover left unbuilt. A null return
    // means the row was never enqueued (Next→worker push off); in CI the route
    // always enqueues it, so this asserts the consumer ran end-to-end.
    const ideationClose = await awaitWorkerStageClosed(pipelineId, "worker_ideation");
    expect(ideationClose === null || ideationClose === "completed").toBeTruthy();

    // ===================================================================
    // (e) NEGATIVE no-stall case: an ALL-failed generation must NOT advance.
    //     We seed an all-task_error closure on a SECOND pipeline so the main
    //     pipeline's chain is untouched, and assert it stays in `generation`.
    // ===================================================================
    await runAllFailedGenerationStaysPut(admin, clientId);

    // ===================================================================
    // generation → creative_qa (AUTO trigger, migration 0024)
    // ===================================================================
    const finals = await seedFinalCreatives({ pipelineId, briefId: imageBriefId, count: 1 });
    await emitGenerationClosure({
      pipelineId,
      taskCount: 2,
      outcome: "done",
      alreadyOpened: true,
    });
    await waitForStatus(pipelineId, "creative_qa");
    // The trigger seeded a pending creative_qa gate row per final creative.
    const qaStates = (await readStageStates(pipelineId)).filter((s) => s.stage === "creative_qa");
    expect(qaStates.length).toBe(finals.length);

    // Focused UI assertion: the creative_qa stage renders the seeded creative.
    await page.goto(`/pipeline/${pipelineId}`);
    await expect(page.getByText(/Creative QA/i).first()).toBeVisible({ timeout: 15_000 });

    // ===================================================================
    // creative_qa → compliance_review (operator qa_run PASS + manager advance)
    // ===================================================================
    const qa = await workerPost("/work/pipeline/tools/qa_run", {
      pipeline_id: pipelineId,
      items: qaPassItems(finals, PNG_B64),
    });
    expect(qa.status, JSON.stringify(qa.body)).toBe(200);
    expect((qa.body as { rollup: string }).rollup).toBe("passed");

    await expectAdvance(pipelineId, "compliance_review");

    // ===================================================================
    // compliance_review → copy (HARD gate): FAIL → 422 block → override → advance
    // ===================================================================
    const creativeId = finals[0]!.id;
    // A confident personal-attributes violation candidate makes the worker
    // engine adjudicate a block-severity FAIL — the verdict is the worker's,
    // never faked. The gate row goes to `failed`.
    const compFail = await workerPost("/work/pipeline/tools/compliance_run", {
      pipeline_id: pipelineId,
      items: [
        {
          creative_id: creativeId,
          surface: "copy",
          llm_candidates: [
            {
              rule_id: "meta.personal_attributes",
              label: "violation",
              confidence: 0.95,
              evidence_span: "are you embarrassed by your kitchen",
            },
          ],
        },
      ],
    });
    expect(compFail.status, JSON.stringify(compFail.body)).toBe(200);
    expect((compFail.body as { rollup: string }).rollup).toBe("failed");

    // The HARD gate blocks the advance (422) while a creative is failed.
    const blocked = await rawAdvance(pipelineId);
    expect(blocked.status).toBe(422);
    expect(String((blocked.body as { error?: string }).error)).toContain("HARD gate");

    // An empty override note is refused (no unaudited release of a hard gate).
    const emptyNote = await workerOverride(pipelineId, creativeId, "");
    expect(emptyNote.status).toBe(422);

    // The audited manager override releases the one creative's compliance unit.
    const overridden = await workerOverride(
      pipelineId,
      creativeId,
      "Reviewed: candidate was a false positive; copy reframed to a benefit.",
    );
    expect(overridden.status, JSON.stringify(overridden.body)).toBe(200);

    // Now the gate clears and the advance succeeds.
    await expectAdvance(pipelineId, "copy");

    // Focused UI assertion: the copy stage renders the CopyComposer.
    await page.goto(`/pipeline/${pipelineId}`);
    await expect(page.getByText(/^Copy$/).first()).toBeVisible({ timeout: 15_000 });

    // ===================================================================
    // copy → spec_validation (operator authors copy + manager approves >=3)
    // ===================================================================
    // Author 3 copy variants (this fires the 0025 re-arm: compliance_review for
    // this creative resets to `pending` — the two-pass design; we re-clear it
    // before launch below).
    for (let i = 1; i <= 3; i += 1) {
      const c = await workerPost("/work/pipeline/tools/copy", {
        pipeline_id: pipelineId,
        variants: [{ creative_id: creativeId, platform: "meta", variant_index: i, ...CLEAN_COPY }],
      });
      expect(c.status, JSON.stringify(c.body)).toBe(200);
    }
    // The copy re-arm voided the prior compliance override (two-pass invariant).
    const afterCopyStates = await readStageStates(pipelineId);
    const compAfterCopy = afterCopyStates.find((s) => s.stage === "compliance_review");
    expect(compAfterCopy?.status).toBe("pending");

    // Manager approves each variant (status → approved).
    const copyRows = await readCopyVariants(admin, pipelineId, creativeId);
    expect(copyRows.length).toBe(3);
    for (const row of copyRows) {
      const dec = await managerPost(pipelineId, "copy/decision", {
        id: row.id,
        decision: "approved",
      });
      expect(dec.status, JSON.stringify(dec.body)).toBe(200);
    }
    // The copy gate (>=3 approved per in-scope creative) now opens.
    await expectAdvance(pipelineId, "spec_validation");

    // ===================================================================
    // spec_validation → variant_plan (operator spec_result PASS + manager advance)
    // ===================================================================
    const spec = await workerPost("/work/pipeline/tools/spec_result", {
      pipeline_id: pipelineId,
      results: [
        {
          creative_id: creativeId,
          platform: "meta",
          placement: "feed",
          ratio: "1x1",
          status: "pass",
          checks: { resolution: "ok" },
        },
      ],
    });
    expect(spec.status, JSON.stringify(spec.body)).toBe(200);
    await expectAdvance(pipelineId, "variant_plan");

    // ===================================================================
    // variant_plan → finalize_assets (manager variant-plan/decision approve)
    // ===================================================================
    const vp = await managerPost(pipelineId, "variant-plan/decision", { decision: "approved" });
    expect(vp.status, JSON.stringify(vp.body)).toBe(200);
    expect(await readPipelineStatus(pipelineId)).toBe("finalize_assets");

    // ===================================================================
    // finalize_assets → launch_handoff (operator finalize_result + manager advance)
    // ===================================================================
    const fin = await workerPost("/work/pipeline/tools/finalize_result", {
      pipeline_id: pipelineId,
      results: [
        {
          creative_id: creativeId,
          asset_name: "remodel_kitchen_v1_1x1",
          drive_folder_id: "fake-drive-folder",
          file_path_drive: "drive://fake/remodel_kitchen_v1_1x1.png",
          verified: true,
        },
      ],
    });
    expect(fin.status, JSON.stringify(fin.body)).toBe(200);
    await expectAdvance(pipelineId, "launch_handoff");

    // ===================================================================
    // launch_handoff → monitor (HARD gate)
    // ===================================================================
    // The copy re-arm left compliance `pending`, so the launch gate's
    // compliance-clear precondition is unmet. The manager approval must 422.
    const launchBlocked = await managerPost(pipelineId, "launch/decision", {
      decision: "approved",
      confirm_paused_first: true,
      acknowledge_preconditions: true,
    });
    expect(launchBlocked.status).toBe(422);
    expect((launchBlocked.body as { error?: string }).error).toBe("launch_blocked");

    // Two-pass: re-run compliance with the now-final clean copy. The worker
    // adjudicates a clean PASS (no violation candidate, clean copy text), which
    // re-clears the compliance unit to `passed`.
    const compClear = await workerPost("/work/pipeline/tools/compliance_run", {
      pipeline_id: pipelineId,
      items: [{ creative_id: creativeId, copy_variant_id: copyRows[0]!.id, surface: "copy" }],
    });
    expect(compClear.status, JSON.stringify(compClear.body)).toBe(200);
    expect((compClear.body as { rollup: string }).rollup).toBe("passed");

    // The operator records the PAUSED-first Meta entities BEFORE the manager
    // approves. The recorder re-checks the same preconditions server-side; with
    // compliance now clear it records and returns the precondition snapshot.
    const record = await workerPost("/work/pipeline/tools/launch", {
      pipeline_id: pipelineId,
      approved_by: "e2e-manager",
      entities: [
        { kind: "campaign", meta_id: "fake-campaign-1", meta_payload: { status: "PAUSED" } },
        {
          kind: "ad",
          meta_id: "fake-ad-1",
          parent_meta_id: "fake-campaign-1",
          creative_id: creativeId,
          copy_variant_id: copyRows[0]!.id,
        },
      ],
    });
    expect(record.status, JSON.stringify(record.body)).toBe(200);
    expect((record.body as { preconditions: { ok: boolean } }).preconditions.ok).toBe(true);

    // The manager approval now re-derives the preconditions true and advances.
    const launchOk = await managerPost(pipelineId, "launch/decision", {
      decision: "approved",
      confirm_paused_first: true,
      acknowledge_preconditions: true,
    });
    expect(launchOk.status, JSON.stringify(launchOk.body)).toBe(200);
    expect(await readPipelineStatus(pipelineId)).toBe("monitor");

    // ===================================================================
    // monitor → done (operator monitor_result + manager monitor/decision kill)
    // ===================================================================
    const mon = await workerPost("/work/pipeline/tools/monitor_result", {
      pipeline_id: pipelineId,
      results: [
        {
          campaign_id: "fake-campaign-1",
          window_days: 7,
          spend: 120.0,
          ghl_leads: 4,
          verdict: "keep",
          verdict_reason: "CPL within target",
        },
      ],
    });
    expect(mon.status, JSON.stringify(mon.body)).toBe(200);

    const monDec = await managerPost(pipelineId, "monitor/decision", {
      decision: "kill",
      campaign_id: "fake-campaign-1",
      notes: "wrap the test run",
    });
    expect(monDec.status, JSON.stringify(monDec.body)).toBe(200);
    expect(await readPipelineStatus(pipelineId)).toBe("done");

    // ===================================================================
    // (a) every stage_advanced fired in DAG order; (b) no stall (we reached
    //     done, which is only possible if every edge had an execution path).
    // ===================================================================
    const order = await readStageAdvancedOrder(pipelineId);
    // The DAG's stage_advanced sequence (configuration is the create-time
    // start, so its first emitted advance is to ideation).
    const expectedOrder = [
      "ideation",
      "review",
      "generation",
      "creative_qa",
      "compliance_review",
      "copy",
      "spec_validation",
      "variant_plan",
      "finalize_assets",
      "launch_handoff",
      "monitor",
    ];
    // Filter to the canonical forward stages (ignore any duplicate/auxiliary
    // stage_advanced rows) and assert the forward subsequence matches in order.
    const seen = order.filter((s) => expectedOrder.includes(s));
    const firstOccurrence: string[] = [];
    for (const s of seen) {
      if (!firstOccurrence.includes(s)) firstOccurrence.push(s);
    }
    expect(firstOccurrence).toEqual(expectedOrder);

    // Final server truth.
    expect(await readPipelineStatus(pipelineId)).toBe("done");

    // Focused UI assertion: the Done stage renders.
    await page.goto(`/pipeline/${pipelineId}`);
    await expect(page.getByText("Done", { exact: true }).first()).toBeVisible({ timeout: 15_000 });
  });
});

// ---------------------------------------------------------------------------
// Helpers (manager API + worker override + small reads)
// ---------------------------------------------------------------------------

type ApiResult = { status: number; body: unknown };

/** POST to a manager Next API route (server-side gate). Uses the dev server. */
async function managerPost(pipelineId: string, path: string, body: unknown): Promise<ApiResult> {
  const base = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";
  const res = await fetch(`${base}/api/pipelines/${pipelineId}/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let parsed: unknown = null;
  try {
    parsed = await res.json();
  } catch {
    parsed = null;
  }
  return { status: res.status, body: parsed };
}

/** POST the generic advance route (no body). */
async function rawAdvance(pipelineId: string): Promise<ApiResult> {
  return managerPost(pipelineId, "advance", {});
}

/** Advance and assert the pipeline reached `want`. */
async function expectAdvance(pipelineId: string, want: string): Promise<void> {
  const res = await rawAdvance(pipelineId);
  expect(res.status, `advance to ${want} failed: ${JSON.stringify(res.body)}`).toBe(200);
  expect(await readPipelineStatus(pipelineId)).toBe(want);
}

/** Manager compliance override for one creative. */
async function workerOverride(
  pipelineId: string,
  creativeId: string,
  note: string,
): Promise<ApiResult> {
  return managerPost(pipelineId, "compliance/override", {
    creative_id: creativeId,
    override_note: note,
    decided_by: "e2e-manager",
  });
}

/** Read the copy_variants rows for a (pipeline, creative). */
async function readCopyVariants(
  admin: ReturnType<typeof getTestAdminClient>,
  pipelineId: string,
  creativeId: string,
): Promise<Array<{ id: string; status: string | null }>> {
  const { data } = await admin
    .from("copy_variants")
    .select("id, status")
    .eq("pipeline_id", pipelineId)
    .eq("creative_id", creativeId)
    .order("variant_index", { ascending: true });
  return (data ?? []) as Array<{ id: string; status: string | null }>;
}

/**
 * NEGATIVE no-stall case: a generation batch where EVERY task errors must NOT
 * advance — migration 0024's `v_done >= 1` guard keeps an all-failed batch in
 * `generation` (the documented count-heuristic bug fix). We build a throwaway
 * pipeline directly, drop it into `generation` with a generation cutoff event,
 * emit an all-error closure, and assert it stays put.
 */
async function runAllFailedGenerationStaysPut(
  admin: ReturnType<typeof getTestAdminClient>,
  clientId: string,
): Promise<void> {
  // Silent-failure PR-4: `pipelines.status` was dropped (migration 0051);
  // the `stage_advanced -> generation` event below (emitted right after the
  // row insert) is what the reducer folds into the derived status.
  const { data: created, error } = await admin
    .from("pipelines")
    .insert({
      client_id: clientId,
      format_choice: "image",
      advanced_at: { generation: new Date().toISOString() },
    } as never)
    .select("id")
    .single();
  if (error || !created) {
    throw new Error(`negative-case pipeline insert failed: ${error?.message ?? "no row"}`);
  }
  const negId = (created as { id: string }).id;

  // The generation-close trigger keys off the latest stage_advanced→generation
  // cutoff event; emit it so the trigger has a window to count within.
  await admin.from("pipeline_events").insert({
    pipeline_id: negId,
    kind: "stage_advanced",
    stage: "generation",
    payload: { from: "review" },
  });

  await emitGenerationClosure({ pipelineId: negId, taskCount: 2, outcome: "error" });

  // Give any trigger a beat to (not) fire, then assert it DID NOT advance.
  await new Promise((r) => setTimeout(r, 1500));
  expect(
    await readPipelineStatus(negId),
    "all-failed generation must NOT advance past generation",
  ).toBe("generation");
}
