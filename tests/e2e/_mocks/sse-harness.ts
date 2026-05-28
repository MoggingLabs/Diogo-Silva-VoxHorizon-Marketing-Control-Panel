import type { Page, Route } from "@playwright/test";

import type { Json } from "@/lib/supabase/types.gen";

import {
  getAdminClient,
  seedGenerationTasks,
  seedIdeationVariants,
  type GenerationSeedPicks,
  type SeededIdeationVariant,
} from "./pipeline-events-seeder";

/**
 * SSE / worker-mock harness for the pipeline e2e specs.
 *
 * The Next.js pipeline routes fire-and-forget POSTs at the worker (running
 * Python FastAPI). The worker isn't part of the e2e dev server; in
 * production those POSTs land on a Tailscale-only host. Since the worker
 * URL is unset in local dev/CI, the fire-and-forget paths in
 * `app/api/pipelines/[id]/advance/route.ts` and
 * `app/api/pipelines/[id]/review/decision/route.ts` no-op without error,
 * which means the UI advances cleanly but no worker writes ever happen.
 *
 * This harness fills that gap two ways:
 *
 *   1. The Ekko draft SSE endpoint (`/api/pipelines/[id]/config/draft`)
 *      proxies a streaming response from the worker. The dev server has
 *      no worker to proxy from, so the route 502s. We intercept the
 *      browser-side fetch via `page.route` and reply with a canned SSE
 *      payload (a single `tool_call_result` for `propose_config` + a
 *      `message_stop`). The modal's existing parser hydrates the form
 *      with whatever payload the spec provides.
 *
 *   2. The ideation + generation worker endpoints don't run, so the
 *      operator-visible side-effects (variants appearing, generation
 *      tasks streaming) never land in the DB. We seed those rows
 *      directly via `pipeline-events-seeder.ts`. The Pipeline detail
 *      page's Supabase Realtime subscriptions deliver the seeded rows to
 *      the UI as if a worker had produced them. The DB auto-advance
 *      trigger handles `generation → done` from the seeded task_done
 *      events — no spec-side status flip needed.
 *
 * Test-only: every helper in this file is keyed to a single Page; no
 * cross-test state lives here. The fixture's automatic cleanup (briefs,
 * creatives, pipelines, pipeline_events via FK cascade) sweeps whatever
 * the harness wrote.
 */

// ---------------------------------------------------------------------------
// Ekko draft SSE mock
// ---------------------------------------------------------------------------

export type ProposedConfigPayload = {
  format_choice: "image" | "video" | "both";
  image_payload?: Record<string, unknown> | null;
  video_payload?: Record<string, unknown> | null;
  notes?: string;
};

/**
 * Intercept `POST /api/pipelines/[pipelineId]/config/draft` and respond
 * with a stub SSE stream that emits exactly one `tool_call_result` for
 * `propose_config` carrying the supplied payload, then `message_stop`.
 *
 * The interception is scoped to the exact pipeline id so unrelated
 * fetches on the same page (Supabase Storage, Auth, etc.) aren't
 * affected. The route is removed automatically when the page closes;
 * specs that re-mock the same id should call `unmockEkkoDraft` first.
 *
 * The SSE wire format matches `worker/src/routes/pipeline.py` exactly:
 * `data: {...}\n\n` lines with a final `message_stop` frame. The modal
 * uses `lib/chat.ts::readChatStream` which is heartbeat-tolerant, so
 * we don't need to emit any `: keepalive` comments here.
 */
export async function mockEkkoDraft(
  page: Page,
  opts: {
    pipelineId: string;
    proposedConfig: ProposedConfigPayload;
  },
): Promise<void> {
  const url = `**/api/pipelines/${opts.pipelineId}/config/draft`;
  const body = buildSseBody([
    { type: "tool_call_result", tool: "propose_config", result: opts.proposedConfig },
    { type: "message_stop" },
  ]);
  await page.route(url, async (route: Route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
      body,
    });
  });
}

/**
 * Remove a previously-installed Ekko-draft mock from the given page.
 * Idempotent — Playwright treats unrouting an absent pattern as a no-op
 * if `behavior: "ignoreErrors"` is set. We match the same URL pattern
 * the mock used so the cleanup is precise.
 */
export async function unmockEkkoDraft(page: Page, pipelineId: string): Promise<void> {
  const url = `**/api/pipelines/${pipelineId}/config/draft`;
  await page.unroute(url);
}

/**
 * Encode a list of StreamChunks into the SSE body the Next.js modal expects.
 * Each chunk lands on its own `data:` line followed by a blank line, matching
 * `worker.src.routes.pipeline._format_sse`.
 */
function buildSseBody(chunks: ReadonlyArray<Record<string, unknown>>): string {
  return chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("");
}

// ---------------------------------------------------------------------------
// Worker ideation mock — seeds variants when /work/pipeline/ideation fires.
// ---------------------------------------------------------------------------

export type MockIdeationOptions = {
  /** Pipeline id whose ideation stage we're mocking. */
  pipelineId: string;
  /** Number of variants to seed for the active track. */
  n: number;
};

/**
 * Configuration → Ideation lands a `briefs` / `video_briefs` row but never
 * produces variants (the worker isn't running). This helper seeds the
 * variants directly so the StageIdeation grid populates.
 *
 * We accept the pipeline id at call time and resolve the briefs server-side
 * — the `configuration → ideation` advance route picks the brief ids and
 * stamps them on the pipeline, so by the time the spec calls this the
 * `image_brief_id` / `video_brief_id` columns are guaranteed to be set.
 *
 * Returns the inserted variants per track so the spec can pick them.
 */
export async function mockWorkerIdeation(
  page: Page,
  opts: MockIdeationOptions,
): Promise<{
  image: SeededIdeationVariant[];
  video: SeededIdeationVariant[];
}> {
  void page; // The harness doesn't intercept network — the worker URL is unset
  // in test so the Next.js advance route's fire-and-forget POST silently
  // no-ops. We just need to seed the rows the worker would have produced.

  const admin = getAdminClient();

  // Silent-failure PR-8: the configuration→ideation advance route enqueues a
  // `worker_ideation` work_item, and the worker-stage consumer (now running in
  // the e2e worker) drains it by invoking the REAL ideation producer. To keep
  // that real producer from racing this seed (it would add its own concepts +
  // break the "Picked: 0 of N" count assertions), emit an ideation task event
  // FIRST: the producer's `ideation_already_ran` probe keys off any task event
  // since the latest `stage_advanced→ideation`, so the consumer claims the row,
  // sees the stage already underway, and closes the work_item WITHOUT
  // re-producing. This is a single fast write right after the advance, so it
  // deterministically wins the race against the consumer's poll interval. The
  // seeded variants below carry their own `task_done(stage=ideation)` events.
  {
    const { error: markerErr } = await admin.from("pipeline_events").insert({
      pipeline_id: opts.pipelineId,
      kind: "task_running",
      stage: "ideation",
      payload: { kind: "ideation", concept: "e2e-ideation-open-marker" } as unknown as Json,
    });
    if (markerErr) {
      throw new Error(`mockWorkerIdeation (open marker) failed: ${markerErr.message}`);
    }
  }

  // The configuration→ideation advance route mints the brief(s) and stamps
  // image_brief_id / video_brief_id on the pipeline, but the spec reaches this
  // helper as soon as the PhaseStepper renders the "Ideation" step label —
  // which is present regardless of the live status — so the advance route's DB
  // write can still be in flight. Poll for the required brief id(s) rather than
  // assuming a single read sees them.
  const deadline = Date.now() + 15_000;
  let imageBriefId: string | null = null;
  let videoBriefId: string | null = null;
  let imageActive = false;
  let videoActive = false;
  for (;;) {
    const { data, error } = await admin
      .from("pipelines")
      .select("image_brief_id, video_brief_id, format_choice")
      .eq("id", opts.pipelineId)
      .maybeSingle();
    if (error || !data) {
      throw new Error(
        `mockWorkerIdeation: pipeline ${opts.pipelineId} not found: ${error?.message ?? "no row"}`,
      );
    }
    imageActive = data.format_choice === "image" || data.format_choice === "both";
    videoActive = data.format_choice === "video" || data.format_choice === "both";
    imageBriefId = data.image_brief_id;
    videoBriefId = data.video_brief_id;
    const imageReady = !imageActive || Boolean(imageBriefId);
    const videoReady = !videoActive || Boolean(videoBriefId);
    if (imageReady && videoReady) break;
    if (Date.now() > deadline) {
      throw new Error(
        `mockWorkerIdeation: pipeline ${opts.pipelineId} brief ids not stamped within 15s ` +
          `(image_brief_id=${imageBriefId}, video_brief_id=${videoBriefId}) — did the ` +
          `configuration→ideation advance commit?`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  let image: SeededIdeationVariant[] = [];
  let video: SeededIdeationVariant[] = [];
  if (imageActive) {
    image = await seedIdeationVariants(opts.pipelineId, imageBriefId as string, "image", opts.n);
  }
  if (videoActive) {
    video = await seedIdeationVariants(opts.pipelineId, videoBriefId as string, "video", opts.n);
  }
  return { image, video };
}

// ---------------------------------------------------------------------------
// Worker generation mock — seeds task chains so the auto-advance trigger
// flips the pipeline forward.
// ---------------------------------------------------------------------------

export type MockGenerationOptions = {
  /** Pipeline id whose generation stage we're mocking. */
  pipelineId: string;
  /** Picks captured at the Ideation stage — drives how many task chains we emit. */
  picks: GenerationSeedPicks;
};

/**
 * Review → Generation lands a `stage_advanced→generation` event and
 * snapshots `cost_estimate`, but the worker never runs, so the queued/
 * running/done task chain never fires and the auto-advance trigger
 * never closes the stage.
 *
 * This helper emits the full chain for every pick + writes the finalized
 * `creatives` / `video_creatives` rows that StageDone reads. The DB-side
 * `pipeline_events_auto_advance_done_trg` trigger sees the closing
 * task_done events and flips `pipelines.status` → `done` itself. No
 * client-side status flip needed.
 *
 * Specs should call this *after* the operator approves at the Review
 * stage (so the `stage_advanced→generation` cutoff event is already in
 * the table). Calling it before approve will still write the rows, but
 * the auto-advance trigger's cutoff lookup returns null and the flip
 * is skipped.
 */
export async function mockWorkerGeneration(page: Page, opts: MockGenerationOptions): Promise<void> {
  void page; // No network interception — see mockWorkerIdeation for why.

  const admin = getAdminClient();
  const { data: pipeline, error } = await admin
    .from("pipelines")
    .select("image_brief_id, video_brief_id")
    .eq("id", opts.pipelineId)
    .maybeSingle();
  if (error || !pipeline) {
    throw new Error(
      `mockWorkerGeneration: pipeline ${opts.pipelineId} not found: ${error?.message ?? "no row"}`,
    );
  }
  await seedGenerationTasks(opts.pipelineId, opts.picks, {
    imageBriefId: pipeline.image_brief_id ?? null,
    videoBriefId: pipeline.video_brief_id ?? null,
  });
}
