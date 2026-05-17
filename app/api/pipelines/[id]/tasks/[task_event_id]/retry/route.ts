import { NextResponse, type NextRequest } from "next/server";

import type { PipelineEventInsert } from "@/lib/pipeline/schemas";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Database, Json } from "@/lib/supabase/types.gen";
import { callWorker, WorkerError } from "@/lib/worker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ id: string; task_event_id: string }>;
};

type SupabaseClient = ReturnType<typeof createAdminClient>;
type PipelineEventRow = Database["public"]["Tables"]["pipeline_events"]["Row"];

/**
 * POST /api/pipelines/:id/tasks/:task_event_id/retry
 *
 * Per-task retry for the Generation stage (PF-E-6 / #198).
 *
 * Looks up the original task event, identifies what to rerun from its
 * payload, kicks the corresponding worker route, and emits a fresh
 * `task_queued` row tagged with `retry_of` so the UI surfaces a new
 * task lifecycle while keeping the original error row in the log.
 *
 * Lifecycle:
 *   1. Validate the referenced event:
 *      - belongs to this pipeline
 *      - is a `task_error` from the generation stage
 *      - carries enough payload metadata to rerun (image: parent
 *        creative + ratio; video: substage + creative_id)
 *   2. Emit `task_queued{retry_of, ...}` immediately so the UI gets a
 *      new row to render.
 *   3. Fire-and-forget the worker call. The background promise emits
 *      `task_running` before the worker call, `task_done` /
 *      `task_error` after — the same kinds the auto-advance trigger
 *      keys on, so a successful retry will let the pipeline auto-flip
 *      to `done` via the DB trigger (PF-E-5).
 *
 * Returns 202 with `{ retry_task_id }` — the id of the new queued
 * event — so the client can correlate the optimistic UI row with the
 * realtime stream.
 *
 * Idempotency: not enforced — the UI button is debounced by the
 * `retrying` state in `<StageGeneration />`. A second POST will queue
 * a second retry chain; that's fine, the original error stays in the
 * log and the pipeline still advances once all chains close.
 */
export async function POST(_req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  const { id: pipelineId, task_event_id: taskEventId } = await ctx.params;
  const supabase = createAdminClient();

  // 1. Load the source event and validate.
  const { data: source, error: srcErr } = await supabase
    .from("pipeline_events")
    .select("*")
    .eq("id", taskEventId)
    .eq("pipeline_id", pipelineId)
    .maybeSingle();
  if (srcErr) {
    return NextResponse.json({ error: srcErr.message }, { status: 500 });
  }
  if (!source) {
    return NextResponse.json({ error: "task event not found" }, { status: 404 });
  }
  if (source.kind !== "task_error") {
    return NextResponse.json(
      {
        error: "validation_failed",
        reason: `retry requires a task_error event, got kind=${source.kind}`,
      },
      { status: 422 },
    );
  }
  if (source.stage !== "generation") {
    return NextResponse.json(
      {
        error: "validation_failed",
        reason: "retry is only supported for generation-stage tasks",
      },
      { status: 422 },
    );
  }

  // 2. Decode the rerun spec from the source payload. Image and video
  //    have different shapes (matching the worker's task_error payloads
  //    in worker/src/routes/pipeline.py).
  const spec = readRetrySpec(source);
  if (!spec.ok) {
    return NextResponse.json({ error: "validation_failed", reason: spec.reason }, { status: 422 });
  }

  // 3. Emit the queued event. Failure here is fatal — without an id
  //    the client has nothing to correlate against and the UI would
  //    silently drop the click.
  const queuedPayload: Record<string, Json> = {
    kind: spec.kind,
    retry_of: taskEventId,
    ...spec.queuedPayload,
  };
  const queuedInsert: PipelineEventInsert = {
    pipeline_id: pipelineId,
    kind: "task_queued",
    stage: "generation",
    payload: queuedPayload as Json,
  };
  const { data: queuedRow, error: queuedErr } = await supabase
    .from("pipeline_events")
    .insert(queuedInsert)
    .select("id")
    .single();
  if (queuedErr || !queuedRow) {
    return NextResponse.json(
      { error: queuedErr?.message ?? "failed to queue retry" },
      { status: 500 },
    );
  }

  // 4. Kick the worker in the background and emit running/done/error
  //    around the call. We intentionally do not `await` so the HTTP
  //    response can return 202 immediately — final renders can take
  //    30–60 s and the client only needs the queued task id to
  //    correlate.
  void runRetry({
    supabase,
    pipelineId,
    queuedEventId: queuedRow.id,
    retryOf: taskEventId,
    spec,
  }).catch((e) => {
    console.warn(`[pipelines.retry] background runner threw: ${String(e)}`);
  });

  return NextResponse.json(
    { retry_task_id: queuedRow.id, source_task_id: taskEventId },
    { status: 202 },
  );
}

// ---------------------------------------------------------------------------
// Retry spec — parsed once at the entry point so the background runner
// doesn't need to revalidate.
// ---------------------------------------------------------------------------

type ImageRetrySpec = {
  ok: true;
  kind: "image";
  parentCreativeId: string;
  concept: string;
  ratio: "1x1" | "9x16";
  queuedPayload: Record<string, Json>;
};

type VideoRetrySpec = {
  ok: true;
  kind: "video";
  creativeId: string;
  substage: string;
  queuedPayload: Record<string, Json>;
};

type ValidRetrySpec = ImageRetrySpec | VideoRetrySpec;

type RetrySpec = ValidRetrySpec | { ok: false; reason: string };

function readRetrySpec(event: PipelineEventRow): RetrySpec {
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const kind = typeof payload.kind === "string" ? payload.kind : null;
  if (kind === "image") {
    const parent = typeof payload.parent_creative_id === "string" ? payload.parent_creative_id : "";
    const concept = typeof payload.concept === "string" ? payload.concept : "";
    const ratio = typeof payload.ratio === "string" ? payload.ratio : "";
    if (!parent) {
      return { ok: false, reason: "image task error missing parent_creative_id" };
    }
    if (ratio !== "1x1" && ratio !== "9x16") {
      return { ok: false, reason: `image task error has unsupported ratio: ${ratio || "<empty>"}` };
    }
    return {
      ok: true,
      kind: "image",
      parentCreativeId: parent,
      concept: concept || "concept",
      ratio,
      queuedPayload: {
        concept: concept || "concept",
        ratio,
        parent_creative_id: parent,
      },
    };
  }
  if (kind === "video") {
    const creativeId = typeof payload.creative_id === "string" ? payload.creative_id : "";
    const substage = typeof payload.substage === "string" ? payload.substage : "";
    if (!creativeId) {
      return { ok: false, reason: "video task error missing creative_id" };
    }
    if (!substage) {
      return { ok: false, reason: "video task error missing substage" };
    }
    return {
      ok: true,
      kind: "video",
      creativeId,
      substage,
      queuedPayload: {
        creative_id: creativeId,
        substage,
      },
    };
  }
  return { ok: false, reason: `unknown task kind: ${kind ?? "<missing>"}` };
}

// ---------------------------------------------------------------------------
// Background runner — emits running / done / error and dispatches to the
// matching worker endpoint.
// ---------------------------------------------------------------------------

async function runRetry({
  supabase,
  pipelineId,
  queuedEventId,
  retryOf,
  spec,
}: {
  supabase: SupabaseClient;
  pipelineId: string;
  queuedEventId: string;
  retryOf: string;
  spec: ValidRetrySpec;
}): Promise<void> {
  const baseRunningPayload: Record<string, Json> = {
    kind: spec.kind,
    retry_of: retryOf,
    queued_event_id: queuedEventId,
    ...spec.queuedPayload,
  };

  await insertEvent(supabase, pipelineId, "task_running", baseRunningPayload);

  try {
    const result = await dispatchWorker(spec);
    await insertEvent(supabase, pipelineId, "task_done", {
      ...baseRunningPayload,
      ...result.donePayload,
    });
    if (result.cost) {
      await insertEvent(supabase, pipelineId, "cost_recorded", {
        ...result.cost,
        task_event_id: queuedEventId,
        retry_of: retryOf,
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await insertEvent(supabase, pipelineId, "task_error", {
      ...baseRunningPayload,
      error: message.slice(0, 500),
    });
  }
}

async function insertEvent(
  supabase: SupabaseClient,
  pipelineId: string,
  kind: "task_running" | "task_done" | "task_error" | "cost_recorded",
  payload: Record<string, Json>,
): Promise<void> {
  const insert: PipelineEventInsert = {
    pipeline_id: pipelineId,
    kind,
    stage: "generation",
    payload: payload as Json,
  };
  const { error } = await supabase.from("pipeline_events").insert(insert);
  if (error) {
    console.warn(`[pipelines.retry] event insert failed (${kind}): ${error.message}`);
  }
}

type WorkerResult = {
  donePayload: Record<string, Json>;
  /**
   * Optional `cost_recorded` payload to emit. Image retries pay for a
   * single Kie.ai call; video retries depend on the substage and may
   * be free (e.g. broll-search uses yt-dlp). Returning null skips the
   * cost row entirely.
   */
  cost: Record<string, Json> | null;
};

async function dispatchWorker(spec: ValidRetrySpec): Promise<WorkerResult> {
  if (spec.kind === "image") {
    return dispatchImageRetry(spec);
  }
  return dispatchVideoRetry(spec);
}

// ---------------------------------------------------------------------------
// Image: call /work/creative/generate with a single-item prompt pack
// reconstructed from the parent creative's stored prompt_used.
// ---------------------------------------------------------------------------

type CreativeRow = {
  id: string;
  brief_id: string | null;
  concept: string | null;
  ratio: string | null;
  prompt_used: Record<string, unknown> | null;
};

type CreativeGenerateResult = {
  brief_id: string;
  creatives_created: number;
  creatives: Array<{
    creative_id: string;
    concept: string;
    ratio: string;
    version: string;
    file_path_supabase: string;
    task_id: string | null;
    source_url: string | null;
  }>;
  errors: string[];
};

async function dispatchImageRetry(spec: ImageRetrySpec): Promise<WorkerResult> {
  const supabase = createAdminClient();
  const { data: parent, error: parentErr } = await supabase
    .from("creatives")
    .select("id, brief_id, concept, ratio, prompt_used")
    .eq("id", spec.parentCreativeId)
    .maybeSingle();
  if (parentErr) throw new Error(`parent creative lookup failed: ${parentErr.message}`);
  if (!parent || !parent.brief_id) {
    throw new Error("parent creative or brief_id missing");
  }

  const parentRow = parent as CreativeRow;
  const promptText = readPromptText(parentRow.prompt_used) || `Final render of ${spec.concept}`;

  const result = await callWorker<CreativeGenerateResult>("/work/creative/generate", {
    method: "POST",
    body: JSON.stringify({
      brief_id: parentRow.brief_id,
      version: "v1.0",
      parent_creative_id: spec.parentCreativeId,
      iteration_kind: "regenerate",
      resolution: "2K",
      prompts: [
        {
          concept: spec.concept,
          prompts: [{ ratio: spec.ratio, text: promptText }],
        },
      ],
    }),
  });

  const generated = result.creatives?.[0];
  if (!generated) {
    const reason =
      result.errors?.[0] ?? "worker returned no creatives_created and no error message";
    throw new Error(reason);
  }

  return {
    donePayload: {
      creative_id: generated.creative_id,
      file_path_supabase: generated.file_path_supabase,
      version: generated.version,
      source_url: generated.source_url ?? null,
    },
    cost: {
      api: "kie.ai",
      units: 1,
      subtotal: 0.05,
      extra: {
        creative_id: generated.creative_id,
        ratio: generated.ratio,
        resolution: "2K",
      },
    },
  };
}

function readPromptText(promptUsed: Record<string, unknown> | null): string {
  if (!promptUsed || typeof promptUsed !== "object") return "";
  const v = (promptUsed as { prompt?: unknown }).prompt;
  return typeof v === "string" ? v : "";
}

// ---------------------------------------------------------------------------
// Video: dispatch by substage to the matching /work/video/<substage>
// endpoint. Each call returns a small payload that the worker route
// already shaped for the generation orchestrator.
// ---------------------------------------------------------------------------

const VIDEO_SUBSTAGE_PATHS: Record<string, string> = {
  script: "/work/video/script",
  voiceover: "/work/video/voiceover",
  broll_search: "/work/video/broll-search",
  broll_pick: "/work/video/broll-select",
  compose: "/work/video/compose",
  caption: "/work/video/caption",
};

const VIDEO_SUBSTAGE_COSTS: Record<string, { api: string; units: number; subtotal: number }> = {
  voiceover: { api: "elevenlabs", units: 1, subtotal: 0.05 },
  compose: { api: "hyperframes", units: 1, subtotal: 0.1 },
  caption: { api: "submagic", units: 1, subtotal: 0.2 },
};

async function dispatchVideoRetry(spec: VideoRetrySpec): Promise<WorkerResult> {
  const path = VIDEO_SUBSTAGE_PATHS[spec.substage];
  if (!path) {
    throw new Error(`unsupported video substage: ${spec.substage}`);
  }

  // Most video endpoints take `{ creative_id }`. The `script` endpoint
  // takes `{ brief_id }`, and `broll_pick` accepts an optional mode —
  // we force "auto" so the retry doesn't block on a UI prompt the
  // generation pipeline never surfaces.
  const body: Record<string, unknown> =
    spec.substage === "script"
      ? await scriptBodyFromCreative(spec.creativeId)
      : spec.substage === "broll_pick"
        ? { creative_id: spec.creativeId, mode: "auto" }
        : { creative_id: spec.creativeId };

  let result: Record<string, unknown>;
  try {
    result = await callWorker<Record<string, unknown>>(path, {
      method: "POST",
      body: JSON.stringify(body),
    });
  } catch (err) {
    if (err instanceof WorkerError) {
      throw new Error(`worker ${path} failed (${err.status ?? "no-status"}): ${err.message}`);
    }
    throw err;
  }

  const donePayload: Record<string, Json> = {};
  // Pluck the canonical path fields each substage emits so the UI can
  // link the operator to the new artifact without a follow-up fetch.
  for (const key of [
    "script_path",
    "voiceover_path",
    "composed_path",
    "captioned_path",
    "creative_id",
  ] as const) {
    const v = result[key];
    if (typeof v === "string") donePayload[key] = v;
  }
  // broll-search returns a `candidates` array; broll-select returns
  // `resolved`. We don't echo the array (it can be large); just a count
  // is plenty for the timeline row.
  if (spec.substage === "broll_search" && Array.isArray(result.candidates)) {
    donePayload.candidates_count = result.candidates.length;
  }
  if (spec.substage === "broll_pick" && Array.isArray(result.resolved)) {
    donePayload.selected_count = result.resolved.length;
  }

  const cost = VIDEO_SUBSTAGE_COSTS[spec.substage];
  return {
    donePayload,
    cost: cost
      ? { ...cost, extra: { creative_id: spec.creativeId, substage: spec.substage } }
      : null,
  };
}

async function scriptBodyFromCreative(creativeId: string): Promise<Record<string, unknown>> {
  // The script endpoint keys off brief_id, not creative_id. Look it up
  // so the retry semantics match what the generation orchestrator does
  // for fresh runs.
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("video_creatives")
    .select("brief_id")
    .eq("id", creativeId)
    .maybeSingle();
  if (error || !data?.brief_id) {
    throw new Error(`could not resolve brief_id for video creative ${creativeId}`);
  }
  return { brief_id: data.brief_id };
}
