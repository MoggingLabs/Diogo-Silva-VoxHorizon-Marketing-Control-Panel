import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { createAdminClient } from "@/lib/supabase/admin";
import { WorkerError, qaRun } from "@/lib/worker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Body for a QA re-run. Everything is optional — the load-bearing input (the
 * creative id) comes from the path, the surface defaults to the creative's own
 * `type`, and the worker fetches the bytes / probes the MP4 itself. Callers may
 * pin a vertical / ratio when the creative metadata is incomplete.
 */
const QARerunInput = z.object({
  surface: z.enum(["image", "video"]).optional(),
  vertical: z.string().trim().min(1).optional(),
  ratio: z.string().trim().min(1).optional(),
});

/**
 * POST /api/creatives/:id/qa
 *
 * Re-run creative QA for one creative. This is the APPEND-ONLY corrective
 * action for `qa_result`: the worker (`/work/pipeline/tools/qa_run`) INSERTs a
 * NEW attempt (`unique(creative_id, attempt)`) and rolls the verdict onto
 * `creative_stage_state(creative_qa)`. It NEVER edits a prior attempt — UPDATE
 * and DELETE on `qa_result` are revoked from the service role (migration 0041),
 * so "change the QA verdict" can only mean "post the next attempt".
 *
 * This route deliberately exposes ONLY POST. The append-only guardrail means
 * there is no PATCH/PUT (edit a prior attempt) and no DELETE (erase history);
 * those verbs 405 below so the contract is self-describing.
 *
 * Contract:
 *   - 400 on malformed JSON.
 *   - 422 when the (optional) body is malformed.
 *   - 404 when the creative doesn't exist.
 *   - 409 when the creative isn't linked to a pipeline (the worker QA tool is
 *     pipeline-scoped — `qa_result.pipeline_id` is NOT NULL).
 *   - 502 when the worker is unreachable / errors.
 *   - 200 with the worker's `{ rollup, results, errors }` on success.
 */
export async function POST(req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  const { id } = await ctx.params;

  let body: unknown = {};
  // An empty body is fine (the common path); only a present-but-malformed body
  // is a 400.
  const raw = await req.text();
  if (raw.trim().length > 0) {
    try {
      body = JSON.parse(raw);
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }
  }
  const parsed = QARerunInput.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation_failed", issues: parsed.error.issues },
      { status: 422 },
    );
  }

  const supabase = createAdminClient();

  // Resolve the creative + its pipeline. Try the image store first, then the
  // video store (a video creative lives in `video_creatives`); the worker QA
  // route confirms the surface against the actual store regardless, but we need
  // the pipeline_id from whichever table owns the row.
  const resolved = await resolveCreative(supabase, id);
  if (resolved.kind === "error") {
    return NextResponse.json({ error: resolved.message }, { status: 500 });
  }
  if (resolved.kind === "not_found") {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  if (!resolved.pipelineId) {
    return NextResponse.json(
      { error: "creative is not linked to a pipeline; cannot run pipeline-scoped QA" },
      { status: 409 },
    );
  }

  const surface = parsed.data.surface ?? (resolved.surface === "video" ? "video" : "image");

  try {
    const result = await qaRun({
      pipeline_id: resolved.pipelineId,
      items: [
        {
          creative_id: id,
          surface,
          ...(parsed.data.vertical ? { vertical: parsed.data.vertical } : {}),
          ...(parsed.data.ratio ? { ratio: parsed.data.ratio } : {}),
        },
      ],
    });
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    if (err instanceof WorkerError) {
      return NextResponse.json(
        { error: "worker_error", status: err.status, detail: err.message },
        { status: 502 },
      );
    }
    return NextResponse.json({ error: "worker_unreachable", detail: String(err) }, { status: 502 });
  }
}

type ResolveResult =
  | { kind: "ok"; pipelineId: string | null; surface: "image" | "video" }
  | { kind: "not_found" }
  | { kind: "error"; message: string };

/**
 * Find the creative in the image store, falling back to the video store, and
 * return its `pipeline_id` + the surface (which table owns it). A hard read
 * error on either store surfaces as `error` (500); a row absent from both is
 * `not_found` (404).
 */
async function resolveCreative(
  supabase: ReturnType<typeof createAdminClient>,
  id: string,
): Promise<ResolveResult> {
  const { data: image, error: imageErr } = await supabase
    .from("creatives")
    .select("id, pipeline_id")
    .eq("id", id)
    .maybeSingle();
  if (imageErr) return { kind: "error", message: imageErr.message };
  if (image) return { kind: "ok", pipelineId: image.pipeline_id, surface: "image" };

  const { data: video, error: videoErr } = await supabase
    .from("video_creatives")
    .select("id, pipeline_id")
    .eq("id", id)
    .maybeSingle();
  if (videoErr) return { kind: "error", message: videoErr.message };
  if (video) return { kind: "ok", pipelineId: video.pipeline_id, surface: "video" };

  return { kind: "not_found" };
}

/**
 * GUARDRAIL: `qa_result` is append-only (0041). Editing or deleting a prior
 * attempt is structurally impossible — the only "change" is the next attempt
 * via POST. These handlers make that explicit at the route boundary.
 */
export function PATCH(): NextResponse {
  return appendOnly405();
}
export function PUT(): NextResponse {
  return appendOnly405();
}
export function DELETE(): NextResponse {
  return appendOnly405();
}

function appendOnly405(): NextResponse {
  return NextResponse.json(
    {
      error: "method_not_allowed",
      reason:
        "qa_result is append-only (migration 0041): a QA re-run POSTs a new attempt; prior attempts cannot be edited or deleted.",
    },
    { status: 405, headers: { Allow: "POST" } },
  );
}
