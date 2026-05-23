import { expect } from "@playwright/test";

import type { Database, Json } from "@/lib/supabase/types.gen";

import { getAdminClient } from "./pipeline-events-seeder";

/**
 * Operator + generation driver for the no-stall workflow e2e
 * (`pipeline-workflow.spec.ts`, T.5 / #318).
 *
 * The 12-stage pipeline advances via THREE executors:
 *
 *   - manager actions  → Next API routes (driven from the spec / UI),
 *   - operator actions → worker tool endpoints (this module calls them over
 *     HTTP exactly as the real Hermes operator would — there is no live agent
 *     in CI, so the test IS the operator),
 *   - auto             → SQL triggers (generation→creative_qa, migration 0024).
 *
 * This module owns the operator HTTP calls + the few direct-DB seeds the worker
 * would otherwise have produced upstream (the final generation creatives — the
 * real worker renders them via Kie; under FAKE_RENDER it still wouldn't run
 * here because no agent drives ideation/generation). Compliance + QA verdicts
 * are NEVER faked: we feed the real worker engines candidate findings and the
 * worker adjudicates them.
 */

const WORKER_URL = (process.env.WORKER_URL ?? "http://localhost:8000").replace(/\/$/, "");
const WORKER_SECRET = process.env.WORKER_SHARED_SECRET ?? "";

type WorkerResponse = { status: number; body: unknown };

/** POST a JSON body to a worker tool endpoint with the shared-secret bearer. */
export async function workerPost(path: string, body: unknown): Promise<WorkerResponse> {
  const res = await fetch(`${WORKER_URL}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${WORKER_SECRET}`,
      "Content-Type": "application/json",
    },
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

/** Assert the worker is reachable + healthy before driving the chain. */
export async function assertWorkerHealthy(): Promise<void> {
  const res = await fetch(`${WORKER_URL}/work/health`, {
    headers: { Authorization: `Bearer ${WORKER_SECRET}` },
  });
  expect(res.status, `worker /work/health should be 200 (is the worker up at ${WORKER_URL}?)`).toBe(
    200,
  );
}

export type SeededFinalCreative = { id: string; ratio: "1x1" | "9x16" };

/**
 * Seed the finalized generation creatives the real worker would have rendered
 * for a picked concept. We set BOTH `pipeline_id` (so the per-creative review
 * fetch + launch gate find them — `lib/review/fetch.getReviewBundle` filters by
 * pipeline_id) AND `brief_id` (so the 0024 generation-close trigger's
 * `brief_id = image_brief_id` join seeds the creative_qa gate row for each).
 *
 * `version='v1.0'` matches the trigger's `version like 'v1%'` filter and the
 * StageDone gallery filter. `has_overlay_text=false` keeps the compliance
 * `google.overlay_text` deterministic check passing.
 */
export async function seedFinalCreatives(args: {
  pipelineId: string;
  briefId: string;
  count: number;
}): Promise<SeededFinalCreative[]> {
  const admin = getAdminClient();
  const out: SeededFinalCreative[] = [];
  for (let i = 0; i < args.count; i += 1) {
    const { data, error } = await admin
      .from("creatives")
      .insert({
        brief_id: args.briefId,
        pipeline_id: args.pipelineId,
        type: "image",
        status: "draft",
        ratio: "1x1",
        version: "v1.0",
        concept: `workflow-final-${i + 1}`,
        has_overlay_text: false,
        file_path_supabase: null,
        file_path_drive: null,
      } as unknown as Database["public"]["Tables"]["creatives"]["Insert"])
      .select("id")
      .single();
    if (error || !data) {
      throw new Error(`seedFinalCreatives failed: ${error?.message ?? "no row"}`);
    }
    out.push({ id: data.id, ratio: "1x1" });
  }
  return out;
}

/**
 * Emit the generation work-closure events the real producer would, so the
 * migration-0024 trigger fires `generation → creative_qa` and seeds the QA gate
 * rows. The trigger keys off the latest `stage_advanced→generation` cutoff
 * (written by the review/decision approve) and the queued/done counts after it,
 * with the all-failed guard (`v_done >= 1`).
 *
 * Pass `outcome: "done"` for the happy path (≥1 success ⇒ advance) or
 * `outcome: "error"` for the NEGATIVE no-stall case (all task_error ⇒ the
 * pipeline must STAY in generation).
 */
export async function emitGenerationClosure(args: {
  pipelineId: string;
  taskCount: number;
  outcome: "done" | "error";
}): Promise<void> {
  const admin = getAdminClient();
  const kinds: Array<"task_queued" | "task_running" | "task_done" | "task_error"> = [];
  for (let i = 0; i < args.taskCount; i += 1) {
    kinds.push("task_queued");
    kinds.push("task_running");
    kinds.push(args.outcome === "done" ? "task_done" : "task_error");
  }
  // Serialize the inserts so the statement-stable trigger sees a stable order
  // and only fires its flip on the final closing event.
  for (const kind of kinds) {
    const { error } = await admin.from("pipeline_events").insert({
      pipeline_id: args.pipelineId,
      kind,
      stage: "generation",
      payload: { kind: "image", ratio: "1x1" } as unknown as Json,
    });
    if (error) {
      throw new Error(`emitGenerationClosure (${kind}) failed: ${error.message}`);
    }
  }
}

/** The four universal QA vision rubric items (non-roofing vertical). */
const QA_PASS_CANDIDATES = [
  { check_id: "vision.hands", score: 0.95 },
  { check_id: "vision.text_glyphs", score: 0.95 },
  { check_id: "vision.anatomy", score: 0.95 },
  { check_id: "vision.surface_artifact", score: 0.95 },
];

/**
 * Build a QA batch the worker engine will adjudicate to `pass` for every
 * creative: a valid 1080×1080 PNG (clears the deterministic resolution/format/
 * size checks, no overlay region) + a high-score candidate for each universal
 * vision rubric item. `vertical` is left null so the roofing sub-rubric never
 * applies (the test client is remodeling).
 */
export function qaPassItems(
  creatives: SeededFinalCreative[],
  imageB64: string,
): Array<Record<string, unknown>> {
  return creatives.map((c) => ({
    creative_id: c.id,
    surface: "image",
    ratio: "1x1",
    image_b64: imageB64,
    vision_candidates: QA_PASS_CANDIDATES,
  }));
}

/** Read a pipeline's current status straight from the DB (server truth). */
export async function readPipelineStatus(pipelineId: string): Promise<string | null> {
  const admin = getAdminClient();
  const { data } = await admin
    .from("pipelines")
    .select("status")
    .eq("id", pipelineId)
    .maybeSingle();
  return data?.status ?? null;
}

/** Read every `stage_advanced` event's stage for a pipeline, in fire order. */
export async function readStageAdvancedOrder(pipelineId: string): Promise<string[]> {
  const admin = getAdminClient();
  const { data } = await admin
    .from("pipeline_events")
    .select("stage, created_at, id")
    .eq("pipeline_id", pipelineId)
    .eq("kind", "stage_advanced")
    .order("created_at", { ascending: true })
    .order("id", { ascending: true });
  return (data ?? []).map((r) => (r as { stage: string }).stage);
}

/**
 * Poll the pipeline status until it equals `want` (or times out). Used to wait
 * for the SQL auto-advance trigger (generation→creative_qa) to land.
 */
export async function waitForStatus(
  pipelineId: string,
  want: string,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const intervalMs = opts.intervalMs ?? 400;
  const deadline = Date.now() + timeoutMs;
  let last: string | null = null;
  while (Date.now() < deadline) {
    last = await readPipelineStatus(pipelineId);
    if (last === want) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitForStatus: pipeline ${pipelineId} stuck at '${last}', wanted '${want}'`);
}

/** Read the per-(creative,stage) gate rows for a pipeline. */
export async function readStageStates(
  pipelineId: string,
): Promise<Array<{ creative_id: string; stage: string; status: string }>> {
  const admin = getAdminClient();
  const { data } = await admin
    .from("creative_stage_state" as never)
    .select("creative_id, stage, status")
    .eq("pipeline_id" as never, pipelineId as never);
  return (data ?? []) as unknown as Array<{
    creative_id: string;
    stage: string;
    status: string;
  }>;
}
