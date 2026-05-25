import { readFileSync } from "node:fs";
import path from "node:path";

import { expect } from "@playwright/test";

import type { Database, Json } from "@/lib/supabase/types.gen";

import { getAdminClient } from "./pipeline-events-seeder";

/** The Supabase Storage bucket the worker reads QA/spec assets from. */
const STORAGE_BUCKET = "creatives";

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

// ===========================================================================
// VIDEO track helpers (Phase 2 / PR2): the full gated video e2e.
//
// The video twin of seedFinalCreatives + qaPassItems. A video pipeline runs
// the SAME 12 gates as image, but its creatives live in `video_creatives`, its
// finished asset is a real MP4 in Supabase Storage (the QA + spec gates probe
// it with ffprobe, no faked verdicts), and its copy lives in
// `video_copy_variants`. These helpers seed exactly what the real worker would
// have produced upstream so the operator/manager drive can carry the run.
// ===========================================================================

/**
 * A clean, compliance-safe spoken script for a video creative. The HARD
 * compliance gate scans the concatenated hook + per-segment voiceover_text;
 * this copy deliberately avoids every deterministic spoken-claim pattern
 * (personal attributes, superlatives, financing, substantiation/guarantee) so
 * the worker engine adjudicates a real PASS (the verdict is never faked).
 */
export const CLEAN_VIDEO_SCRIPT_OUTLINE = {
  hook: "Here is how a kitchen remodel comes together from start to finish.",
  segments: [
    {
      topic: "Planning the layout",
      duration_s: 15,
      voiceover_text:
        "Our local team walks the space with you and plans a layout that fits how you cook and gather.",
    },
  ],
  outro: "Book a free planning visit when you are ready.",
};

/** The repo-relative path the CI step writes the generated MP4 fixture to. */
export const VIDEO_FIXTURE_REPO_PATH = "tests/e2e/_assets/video-fixture.mp4";

/**
 * Read the CI-generated MP4 fixture from disk. The `.github/workflows/ci.yml`
 * e2e job generates a 9:16 H.264 + AAC clip at {@link VIDEO_FIXTURE_REPO_PATH}
 * with ffmpeg BEFORE running the spec; this resolves it relative to the repo
 * root (the Playwright runner's cwd) so the spec/uploader can read the bytes.
 * Throws a precise error when the fixture is missing so a misconfigured CI step
 * fails loudly rather than uploading an empty object.
 */
export function readVideoFixtureBytes(): Buffer {
  const abs = path.resolve(process.cwd(), VIDEO_FIXTURE_REPO_PATH);
  try {
    const bytes = readFileSync(abs);
    if (bytes.length === 0) {
      throw new Error(`video fixture at ${abs} is empty`);
    }
    return bytes;
  } catch (e) {
    throw new Error(
      `could not read MP4 fixture at ${abs}: the CI e2e job must run the ` +
        `"Generate video fixture (ffmpeg)" step before the spec. Underlying: ${String(e)}`,
    );
  }
}

/**
 * Upload the real MP4 fixture to the `creatives` Storage bucket at `objectPath`
 * (upsert). The worker's qa_run + spec backstop download THIS SAME object via
 * the creative's `captioned_path`, then ffprobe it, so the bytes must round-
 * trip through Storage. Returns the object path written.
 */
export async function uploadVideoFixture(objectPath: string): Promise<string> {
  const admin = getAdminClient();
  const bytes = readVideoFixtureBytes();
  const { error } = await admin.storage.from(STORAGE_BUCKET).upload(objectPath, bytes, {
    contentType: "video/mp4",
    upsert: true,
  });
  if (error) {
    throw new Error(`uploadVideoFixture(${objectPath}) failed: ${error.message}`);
  }
  return objectPath;
}

export type SeededVideoCreative = { id: string; captionedPath: string };

/**
 * Seed the finalized VIDEO creatives the real worker would have rendered for a
 * picked concept. Each row is written to `video_creatives` at
 * `status='captioned'` (the deliverable that enters QA; the B1 trigger seeds
 * the creative_qa gate for `status='captioned'` rows joined on
 * `video_brief_id`), with:
 *   - `captioned_path` -> a unique Storage object holding the uploaded MP4
 *     fixture (qa_run + the spec backstop download + ffprobe THIS object),
 *   - a CLEAN `script_outline` (0040) so the HARD compliance gate's spoken-claim
 *     scan adjudicates a real PASS.
 *
 * We deliberately do NOT set `video_creatives.pipeline_id`: the B1 seed trigger
 * + the review-bundle fetch join via `video_brief_id`, and that FK has no
 * ON DELETE rule (setting it would block the fixture's pipeline teardown). The
 * AFTER INSERT mirror trigger (0034) writes the neutral `creative` base row, so
 * each id is a valid creative_stage_state / spec_check / ad_entity key.
 */
export async function seedFinalVideoCreatives(args: {
  pipelineId: string;
  briefId: string;
  count: number;
  /** A repeatable object-path prefix; each creative gets `<prefix>-<i>.mp4`. */
  pathPrefix?: string;
}): Promise<SeededVideoCreative[]> {
  const admin = getAdminClient();
  const prefix = args.pathPrefix ?? `${args.briefId}/e2e-captioned`;
  const out: SeededVideoCreative[] = [];
  for (let i = 0; i < args.count; i += 1) {
    const captionedPath = `${prefix}-${i + 1}.mp4`;
    await uploadVideoFixture(captionedPath);
    const { data, error } = await admin
      .from("video_creatives")
      .insert({
        brief_id: args.briefId,
        version: 1,
        status: "captioned",
        captioned_path: captionedPath,
        composed_path: captionedPath,
        duration_actual_s: 4,
        script_outline: CLEAN_VIDEO_SCRIPT_OUTLINE as unknown as Json,
      } as unknown as Database["public"]["Tables"]["video_creatives"]["Insert"])
      .select("id")
      .single();
    if (error || !data) {
      throw new Error(`seedFinalVideoCreatives failed: ${error?.message ?? "no row"}`);
    }
    out.push({ id: data.id, captionedPath });
  }
  return out;
}

/**
 * Build a QA batch for video creatives. NO `image_b64` (the worker downloads
 * the captioned MP4 from Storage + ffprobes it); `ratio` rides along but the
 * worker prefers the brief's declared `dimensions`. The worker computes the
 * verdict from the probed facts; this only names which creatives to QA.
 */
export function qaVideoItems(creatives: SeededVideoCreative[]): Array<Record<string, unknown>> {
  return creatives.map((c) => ({
    creative_id: c.id,
    surface: "video",
    ratio: "9x16",
  }));
}

/**
 * Soft-delete the ideation-stage video drafts for a brief (every
 * `video_creatives` row that is NOT one of `keepIds`). The video post-
 * generation gates + the review bundle scope a video creative by
 * `brief_id = video_brief_id AND deleted_at IS NULL` (there is no
 * `pipeline_id`/version discriminator the way image creatives have), so the
 * unfinished ideation drafts would otherwise count as in-scope creatives with
 * no gate state and hold every gate. Dropping them mirrors the real flow: only
 * the picked concept's render proceeds to QA. Returns the count soft-deleted.
 */
export async function dropVideoIdeationDrafts(args: {
  briefId: string;
  keepIds: string[];
}): Promise<number> {
  const admin = getAdminClient();
  const { data: rows, error: readErr } = await admin
    .from("video_creatives")
    .select("id")
    .eq("brief_id", args.briefId)
    .is("deleted_at", null);
  if (readErr) {
    throw new Error(`dropVideoIdeationDrafts read failed: ${readErr.message}`);
  }
  const keep = new Set(args.keepIds);
  const toDrop = (rows ?? []).map((r) => (r as { id: string }).id).filter((id) => !keep.has(id));
  if (toDrop.length === 0) return 0;
  const { error: updErr } = await admin
    .from("video_creatives")
    .update({ deleted_at: new Date().toISOString() } as never)
    .in("id", toDrop);
  if (updErr) {
    throw new Error(`dropVideoIdeationDrafts update failed: ${updErr.message}`);
  }
  return toDrop.length;
}

/**
 * Read the `video_copy_variants` rows for a set of video creatives, ordered by
 * (creative, variant_index). Mirrors `readCopyVariants` (image): used to fetch
 * the ids the manager copy/decision route approves.
 */
export async function readVideoCopyVariants(
  creativeIds: string[],
): Promise<Array<{ id: string; creative_id: string; status: string | null }>> {
  const admin = getAdminClient();
  const { data } = await admin
    .from("video_copy_variants")
    .select("id, creative_id, status")
    .in("creative_id", creativeIds)
    .order("variant_index", { ascending: true });
  return (data ?? []) as Array<{ id: string; creative_id: string; status: string | null }>;
}
