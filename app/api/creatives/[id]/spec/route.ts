import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { createAdminClient } from "@/lib/supabase/admin";
import { WorkerError, specRun, type WorkerSpecResult } from "@/lib/worker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Manager spec override input. The override targets ONE placement
 * (`platform` + `placement`) and sets its corrected `status`. `reason` is the
 * audited justification — REQUIRED and non-empty: a spec override is a manager
 * release of a placement hold, so it must carry a written reason (the same
 * shape the compliance override enforces). The reason is stamped into the
 * `spec_check.checks` jsonb the worker persists so the audit travels with the
 * row (spec_check has no dedicated override columns).
 */
const SpecOverrideInput = z.object({
  platform: z.enum(["meta", "google", "tiktok"]).default("meta"),
  placement: z.string().trim().min(1, "placement is required"),
  status: z.enum(["pending", "pass", "warn", "fail", "exception"]),
  reason: z.string().trim().min(1, "reason is required"),
  ratio: z.string().trim().min(1).optional(),
  decided_by: z.string().trim().min(1).default("manager"),
});

/**
 * POST /api/creatives/:id/spec
 *
 * Manager spec override for one placement. `spec_check` is OVERRIDE-ROUTE only
 * (it is mutable, but NOT via a raw UPDATE from the browser): the worker upserts
 * the row (idempotent on `(creative_id, platform, placement)`) and rolls the
 * verdict onto `creative_stage_state(spec_validation)`. This route submits a
 * corrected per-placement result through that worker upsert + rollup, with a
 * required audited reason. There is no raw status PATCH (see below).
 *
 * Contract:
 *   - 400 on malformed JSON.
 *   - 422 when `reason`/`placement`/`status` are missing or malformed.
 *   - 404 when the creative doesn't exist.
 *   - 409 when the creative isn't linked to a pipeline (spec_check.pipeline_id
 *     is NOT NULL; the worker tool is pipeline-scoped).
 *   - 502 when the worker is unreachable / errors.
 *   - 200 with the worker's response on success.
 */
export async function POST(req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  const { id } = await ctx.params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = SpecOverrideInput.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation_failed", issues: parsed.error.issues },
      { status: 422 },
    );
  }

  const supabase = createAdminClient();

  const resolved = await resolveCreative(supabase, id);
  if (resolved.kind === "error") {
    return NextResponse.json({ error: resolved.message }, { status: 500 });
  }
  if (resolved.kind === "not_found") {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  if (!resolved.pipelineId) {
    return NextResponse.json(
      { error: "creative is not linked to a pipeline; cannot override spec" },
      { status: 409 },
    );
  }

  const { platform, placement, status, reason, ratio, decided_by } = parsed.data;
  const result: WorkerSpecResult = {
    creative_id: id,
    platform,
    placement,
    status,
    // The reason + actor ride along in the checks jsonb so the override is
    // auditable on the persisted spec_check row.
    checks: {
      override: true,
      override_reason: reason,
      overridden_by: decided_by,
      overridden_at: new Date().toISOString(),
    },
    ...(ratio ? { ratio } : {}),
  };

  try {
    const out = await specRun({ pipeline_id: resolved.pipelineId, results: [result] });
    return NextResponse.json(out, { status: 200 });
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
  | { kind: "ok"; pipelineId: string | null }
  | { kind: "not_found" }
  | { kind: "error"; message: string };

/** Resolve the creative's pipeline_id from the image store, then the video store. */
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
  if (image) return { kind: "ok", pipelineId: image.pipeline_id };

  const { data: video, error: videoErr } = await supabase
    .from("video_creatives")
    .select("id, pipeline_id")
    .eq("id", id)
    .maybeSingle();
  if (videoErr) return { kind: "error", message: videoErr.message };
  if (video) return { kind: "ok", pipelineId: video.pipeline_id };

  return { kind: "not_found" };
}

/**
 * GUARDRAIL: `spec_check` is override-route only. A raw status PATCH from the
 * browser would bypass the worker upsert + the `creative_stage_state` rollup
 * (and would let the operator assert a pass the worker never computed), so it
 * is refused. The corrected status flows through POST (the worker spec route).
 */
export function PATCH(): NextResponse {
  return managedOnly405();
}
export function PUT(): NextResponse {
  return managedOnly405();
}
export function DELETE(): NextResponse {
  return managedOnly405();
}

function managedOnly405(): NextResponse {
  return NextResponse.json(
    {
      error: "method_not_allowed",
      reason:
        "spec_check is managed via the worker spec route + the DB rollup, not a raw edit/delete. Submit a corrected result via POST.",
    },
    { status: 405, headers: { Allow: "POST" } },
  );
}
