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
  /**
   * FIX-A deterministic-mode QA: the deterministic ``worker_qa`` consumer fetches
   * the creative bytes from ``file_path_supabase`` (the operator-supplied b64 path
   * does not exist when there is no operator). Pass a valid 1080x1080 PNG b64 to
   * upload it to Storage + stamp ``file_path_supabase`` so the worker QA engine
   * can download + adjudicate a real PASS. Omit for the operator-mode assertions
   * (no real QA runs there -- only the dispatch enqueue is under test).
   */
  imageB64?: string;
}): Promise<SeededFinalCreative[]> {
  const admin = getAdminClient();
  const out: SeededFinalCreative[] = [];
  for (let i = 0; i < args.count; i += 1) {
    let filePath: string | null = null;
    if (args.imageB64) {
      filePath = `${args.briefId}/e2e-final-${i + 1}.png`;
      const bytes = Buffer.from(args.imageB64, "base64");
      const { error: upErr } = await admin.storage
        .from(STORAGE_BUCKET)
        .upload(filePath, bytes, { contentType: "image/png", upsert: true });
      if (upErr) {
        throw new Error(`seedFinalCreatives upload failed: ${upErr.message}`);
      }
    }
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
        file_path_supabase: filePath,
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
 * Open the generation batch so the PR-8 worker-stage consumer treats it as
 * already-in-flight and does NOT re-render. Call this IMMEDIATELY after the
 * review approve (which enqueues the `worker_generation` work_item) and BEFORE
 * seeding the finals.
 *
 * Why: with a real consumer draining `worker_generation`, there is a race
 * between the route enqueuing the row and the spec seeding the deterministic
 * closure. If the consumer claimed the row in that window it would run the real
 * generation producer (rendering image finals under FAKE_RENDER), which would
 * add v1.0 creatives that break the per-creative QA-gate assertions. Emitting an
 * OPEN batch (`taskCount` × `task_queued` + `task_running`, no `task_done`)
 * makes the producer's `generation_state` probe report `already_running`, so the
 * consumer claims the row, runs the in-process service, finds the stage in
 * flight, and closes the work_item WITHOUT rendering. This is a fast DB write
 * right after approve, so it deterministically wins the race against the
 * consumer's poll interval -- and `emitGenerationClosure` (terminal events only)
 * then balances these and drives the actual `generation → creative_qa` advance.
 *
 * Contract: pair this with `emitGenerationClosure({ taskCount })` using the SAME
 * `taskCount` so the migration-0051 closure predicate balances
 * (`done >= greatest(queued, running)`).
 */
export async function seedGenerationOpenMarker(pipelineId: string, taskCount = 2): Promise<void> {
  const admin = getAdminClient();
  const count = Math.max(1, taskCount);
  for (let i = 0; i < count; i += 1) {
    const payload = { kind: "image", concept: `e2e-open-${i + 1}` } as Json;
    for (const kind of ["task_queued", "task_running"] as const) {
      const { error } = await admin.from("pipeline_events").insert({
        pipeline_id: pipelineId,
        kind,
        stage: "generation",
        payload,
      });
      if (error) {
        throw new Error(`seedGenerationOpenMarker (${kind}) failed: ${error.message}`);
      }
    }
  }
}

/**
 * Drive the `generation → creative_qa` transition AND prove the real PR-8
 * worker-stage consumer ran the deterministic generation work.
 *
 * Silent-failure PR-8 reconciliation: the worker-stage consumer
 * (`services.worker_stage_consumer`) now runs in the e2e worker and CLAIMS the
 * `worker_generation` work_item the review approve enqueued. This helper no
 * longer SIMULATES generation by flipping that work_item itself (wrong +
 * duplicative now that a real consumer owns the row). Instead it seeds the
 * deterministic closure the migration-0051 trigger keys off (the
 * `task_done(stage=generation)` chains -- the UPSTREAM-output stand-in, since
 * image finals run for real under FAKE_RENDER but the VIDEO render chain has no
 * fake mode in CI) and then awaits the real consumer claiming + closing the row.
 *
 * Pair the happy path with `seedGenerationOpenMarker(taskCount)` right after the
 * approve + pass `alreadyOpened: true` here; see those two docstrings for the
 * race-elimination contract.
 */
export async function emitGenerationClosure(args: {
  pipelineId: string;
  taskCount: number;
  outcome: "done" | "error";
  alreadyOpened?: boolean;
}): Promise<void> {
  const admin = getAdminClient();
  const count = Math.max(1, args.taskCount);
  const terminal = args.outcome === "done" ? "task_done" : "task_error";
  // When the batch was pre-opened by `seedGenerationOpenMarker` (the happy path,
  // to win the consumer race), emit ONLY the terminal events to balance + close.
  // Otherwise (the negative all-failed case on a throwaway pipeline that never
  // opened a batch) emit a self-contained balanced chain. The migration-0051
  // closure predicate is `done >= greatest(queued, running) and done >= 1`, so
  // balanced counts advance on `done` and leave an all-error batch stuck.
  const kinds: ReadonlyArray<"task_queued" | "task_running" | "task_done" | "task_error"> =
    args.alreadyOpened ? [terminal] : ["task_queued", "task_running", terminal];
  for (let i = 0; i < count; i += 1) {
    const payload = { kind: "image", concept: `e2e-closure-${i + 1}` } as Json;
    for (const kind of kinds) {
      const { error } = await admin.from("pipeline_events").insert({
        pipeline_id: args.pipelineId,
        kind,
        stage: "generation",
        payload,
      });
      if (error) {
        throw new Error(`emitGenerationClosure (${kind}) failed: ${error.message}`);
      }
    }
  }

  // Prove the real consumer claimed + closed the worker_generation row. Only
  // the happy-path pipelines actually enqueued one (the review approve route);
  // the negative case seeds a throwaway pipeline with no real work_item, so
  // there is nothing for the consumer to close -- skip the wait there.
  if (args.outcome === "done") {
    await awaitWorkerStageClosed(args.pipelineId, "worker_generation");
  }
}

/**
 * Wait for the PR-8 worker-stage consumer to CLAIM and CLOSE (terminal status)
 * the `work_item` of `kind` for a pipeline. This is the e2e proof that the
 * deterministic ideation/generation consumer half runs end-to-end: the route
 * enqueued the row `queued`, the consumer claimed it (`claimed`/`running`), ran
 * the in-process service, and closed it (`completed`, or `failed`/`timed_out`
 * if it genuinely faulted). Returns the terminal status observed.
 *
 * Tolerates the row never having been enqueued (returns `null`) so a spec that
 * runs with the Next→worker push off (no `WORKER_URL`) and never created the
 * row does not hang -- but in CI the routes always enqueue it via the admin
 * client regardless of `WORKER_URL`, so the consumer path IS exercised.
 */
export type WorkerStageKind =
  | "worker_ideation"
  | "worker_generation"
  | "worker_monitor"
  | "worker_qa"
  | "worker_compliance"
  | "worker_spec";

export async function awaitWorkerStageClosed(
  pipelineId: string,
  kind: WorkerStageKind,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<string | null> {
  const admin = getAdminClient();
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const intervalMs = opts.intervalMs ?? 400;
  const deadline = Date.now() + timeoutMs;
  const terminal = new Set(["completed", "failed", "timed_out", "cancelled"]);
  let lastStatus: string | null = null;
  let everSeen = false;
  while (Date.now() < deadline) {
    const { data } = await admin
      .from("work_item")
      .select("status")
      .eq("pipeline_id", pipelineId)
      .eq("kind", kind)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const status = (data as { status?: string } | null)?.status ?? null;
    if (status) {
      everSeen = true;
      lastStatus = status;
      if (terminal.has(status)) return status;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  if (!everSeen) return null;
  throw new Error(
    `awaitWorkerStageClosed: ${kind} for pipeline ${pipelineId} stuck at '${lastStatus}' ` +
      `(never reached a terminal status within ${timeoutMs}ms) -- the worker-stage consumer ` +
      `did not claim+close it. Is the scheduler's worker_stage_drain loop running?`,
  );
}

/**
 * Wait for a `work_item` of `kind` to EXIST for a pipeline (any status), and
 * optionally assert its `payload.stage`. This is the FIX-A dispatch-on-entry
 * proof: the missing seam was that a post-generation stage had NO producer (no
 * work_item was ever enqueued), so the pipeline deadlocked. Asserting the row
 * exists proves the dispatch fired -- for the OPERATOR path, where the daemon's
 * Hermes chat can't run in CI, the enqueue-on-entry IS the thing under test
 * (the chat itself is unit-tested separately). Returns the row's id + status +
 * payload stage. Throws on timeout (the producer never fired -> the deadlock).
 */
export async function awaitWorkItemEnqueued(
  pipelineId: string,
  kind: string,
  payloadStage?: string,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<{ id: string; status: string; stage: string | null }> {
  const admin = getAdminClient();
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const intervalMs = opts.intervalMs ?? 300;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { data } = await admin
      .from("work_item")
      .select("id, status, payload")
      .eq("pipeline_id", pipelineId)
      .eq("kind", kind as never)
      .order("created_at", { ascending: false })
      .limit(1);
    const row = (data ?? [])[0] as
      | { id: string; status: string; payload: Record<string, unknown> | null }
      | undefined;
    if (row) {
      const stage = (row.payload?.stage as string | undefined) ?? null;
      if (payloadStage === undefined || stage === payloadStage) {
        return { id: row.id, status: row.status, stage };
      }
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(
    `awaitWorkItemEnqueued: no work_item of kind '${kind}'` +
      `${payloadStage ? ` (payload.stage='${payloadStage}')` : ""} ever appeared for pipeline ` +
      `${pipelineId} within ${timeoutMs}ms -- the dispatch-on-entry producer did not fire.`,
  );
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

/** Read a pipeline's current status straight from the DB (server truth).
 *  Silent-failure PR-4: `pipelines.status` was dropped (migration 0051);
 *  the canonical answer comes from the `compute_pipeline_status(id)` RPC,
 *  which folds the event stream into a `pipeline_status_enum` value.
 */
export async function readPipelineStatus(pipelineId: string): Promise<string | null> {
  const admin = getAdminClient();
  const { data } = await admin.rpc("compute_pipeline_status", { p_pipeline_id: pipelineId });
  return (typeof data === "string" ? data : null) ?? null;
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
