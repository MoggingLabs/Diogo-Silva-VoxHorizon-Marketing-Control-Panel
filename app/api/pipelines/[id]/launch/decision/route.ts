import { NextResponse, type NextRequest } from "next/server";

import { getDerivedStatus } from "@/lib/pipeline/derived-status";
import { LaunchDecisionInput } from "@/lib/pipeline/decision-schemas";
import { type PipelineEventInsert, type PipelineUpdate } from "@/lib/pipeline/schemas";
import type { PipelineStatus } from "@/lib/pipeline/types";
import { getReviewBundle } from "@/lib/review/fetch";
import { buildGridRows, launchPreconditions, launchReady } from "@/lib/review/grid";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/types.gen";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * POST /api/pipelines/:id/launch/decision
 *
 * The HARD launch gate (#361, P4.6). The manager approves the PAUSED-first
 * launch once the preconditions hold (spec-pass ∧ compliance-clear ∧ ≥3
 * approved copy/creative). The route:
 *   - guards the pipeline is in `launch_handoff` (409 otherwise),
 *   - **re-derives the preconditions server-side** from the live per-creative
 *     data (never trusts the client) and refuses (422) if they aren't met —
 *     the compliance/launch gates never auto-pass,
 *   - on approve: records the decision and advances to `monitor`,
 *   - on reject: stays in `launch_handoff` (the manager can re-evaluate); the
 *     rejection is recorded on the timeline.
 *
 * NOTE: there is NO worker push from this route. Per the locked design (Layer 6,
 * PIPELINE-REBUILD-ARCHITECTURE.md) the Meta launch is operator-held MCP: the
 * operator creates the PAUSED-first entities and records them via
 * `POST /work/pipeline/tools/launch` (the recorder + server-side hard gate)
 * BEFORE the manager approves here, and the Meta *activate* step is a separate,
 * approval-gated operator action (the approvals plugin). This route only
 * re-derives the preconditions and opens the launch handoff to `monitor`; the
 * operator's own monitor dispatch carries the run forward from there.
 */
export async function POST(req: NextRequest, ctx: RouteContext) {
  const { id } = await ctx.params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = LaunchDecisionInput.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation_failed", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const { decision, notes } = parsed.data;

  const supabase = createAdminClient();

  const { data: pipeline, error: readErr } = await supabase
    .from("pipelines")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (readErr) {
    return NextResponse.json({ error: readErr.message }, { status: 500 });
  }
  if (!pipeline) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  // Silent-failure PR-4: read derived status from the reducer
  // (`pipelines.status` was dropped in 0051).
  const derivedStatus = await getDerivedStatus(supabase, pipeline.id);
  if (derivedStatus !== "launch_handoff") {
    return NextResponse.json(
      { error: "invalid_state", current: derivedStatus, expected: "launch_handoff" },
      { status: 409 },
    );
  }

  const now = new Date().toISOString();

  if (decision === "rejected") {
    const event: PipelineEventInsert = {
      pipeline_id: id,
      kind: "launch_rejected",
      stage: "launch_handoff",
      payload: { notes: notes ?? null } as Json,
    };
    const { error: evErr } = await supabase.from("pipeline_events").insert(event);
    if (evErr) {
      console.warn(`[pipelines.launch.decision] event insert failed: ${evErr.message}`);
    }
    return NextResponse.json({
      pipeline: { ...pipeline, status: "launch_handoff" as PipelineStatus },
      decision,
    });
  }

  // Approve: re-derive the preconditions from the live per-creative data. The
  // hard gate NEVER trusts the client and NEVER auto-passes.
  const bundle = await getReviewBundle(id);
  const rows = buildGridRows(bundle.creatives, bundle.states);
  const preconditions = launchPreconditions(rows, bundle.copyVariants);
  if (!launchReady(preconditions)) {
    return NextResponse.json(
      {
        error: "launch_blocked",
        reason: "launch preconditions not met (spec-pass + compliance-clear + >=3 approved copy)",
        preconditions,
      },
      { status: 422 },
    );
  }

  const advancedAt =
    pipeline.advanced_at &&
    typeof pipeline.advanced_at === "object" &&
    !Array.isArray(pipeline.advanced_at)
      ? (pipeline.advanced_at as Record<string, string>)
      : {};
  // Silent-failure PR-4: `pipelines.status` was dropped (migration 0051).
  // The stage_advanced event below is the canonical status write.
  const update: PipelineUpdate = {
    advanced_at: { ...advancedAt, monitor: now } as unknown as Json,
  };
  const { data: updated, error: updateErr } = await supabase
    .from("pipelines")
    .update(update)
    .eq("id", id)
    .select()
    .single();
  if (updateErr || !updated) {
    return NextResponse.json(
      { error: updateErr?.message ?? "launch advance failed" },
      { status: 500 },
    );
  }

  // FINDING 3 (silent-failure FIX-F): the stage_advanced->monitor event is the
  // SOLE input that flips the reducer (compute_pipeline_status) to monitor.
  // Swallowing a failed insert with console.warn + 200 status='monitor' left
  // the reducer one stage behind (still launch_handoff) under a false UI, so a
  // re-evaluation 409s 'invalid_state'. Make the insert strict (500 on failure)
  // -- the same failure class the sibling advance/route.ts already 5xxes.
  const event: PipelineEventInsert = {
    pipeline_id: id,
    kind: "stage_advanced",
    stage: "monitor",
    payload: { decision, paused_first: true } as Json,
  };
  const { error: evErr } = await supabase.from("pipeline_events").insert(event);
  if (evErr) {
    return NextResponse.json(
      { error: `stage_advanced event insert failed: ${evErr.message}` },
      { status: 500 },
    );
  }

  // No worker push: the operator already recorded the PAUSED-first Meta entities
  // via `POST /work/pipeline/tools/launch` (the recorder + server-side hard
  // gate) before this approval, and the Meta activate step is a separate
  // approval-gated operator MCP action. Advancing to `monitor` here is the
  // committed gate; the operator's own monitor dispatch drives the next stage.
  return NextResponse.json({
    pipeline: { ...updated, status: "monitor" as PipelineStatus },
    decision,
    preconditions,
  });
}
