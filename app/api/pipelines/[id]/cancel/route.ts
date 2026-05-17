import { NextResponse, type NextRequest } from "next/server";

import type { PipelineEventInsert, PipelineUpdate } from "@/lib/pipeline/schemas";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/types.gen";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * POST /api/pipelines/:id/cancel
 *
 * Operator-triggered cancellation. Flips the pipeline to `status='cancelled'`
 * from any of the non-terminal stages (`configuration`, `ideation`, `review`,
 * `generation`) and emits a `pipeline_events(kind='stage_advanced',
 * stage='cancelled', payload={reason: 'operator_cancel'})` row so the timeline
 * reflects the cancel.
 *
 * Status guard: returns 409 if the pipeline is already `cancelled` or `done`
 * — both are terminal in v1. The `from` field on the error body lets the UI
 * surface "this pipeline was already finished/cancelled".
 *
 * Concurrency: the status assertion is re-applied at write time
 * (`.in('status', [...])`) so a concurrent advance can't race a cancel into a
 * terminal stage.
 *
 * Worker abort: when a pipeline is mid-generation the running worker still
 * needs to notice the cancel and stop polling. For v1 we rely on a simple
 * "DB status flip + worker checks before each substage" pattern — the worker
 * reads `pipelines.status` between substages and exits cleanly when it sees
 * `cancelled`. A dedicated abort-store (mirroring
 * `worker/src/services/chat_abort.py`) is the v2 path; we punt that here.
 */
export async function POST(_req: NextRequest, ctx: RouteContext) {
  const { id } = await ctx.params;

  const supabase = createAdminClient();
  const { data: pipeline, error: readErr } = await supabase
    .from("pipelines")
    .select("id, status, advanced_at")
    .eq("id", id)
    .maybeSingle();
  if (readErr) {
    return NextResponse.json({ error: readErr.message }, { status: 500 });
  }
  if (!pipeline) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  if (pipeline.status === "cancelled" || pipeline.status === "done") {
    return NextResponse.json({ error: "invalid_state", from: pipeline.status }, { status: 409 });
  }

  const previousStatus = pipeline.status;
  const now = new Date().toISOString();

  // Stamp `advanced_at.cancelled` without clobbering earlier stage marks.
  const advancedAt =
    pipeline.advanced_at &&
    typeof pipeline.advanced_at === "object" &&
    !Array.isArray(pipeline.advanced_at)
      ? (pipeline.advanced_at as Record<string, string>)
      : {};
  const nextAdvancedAt = { ...advancedAt, cancelled: now };

  const update: PipelineUpdate = {
    status: "cancelled",
    advanced_at: nextAdvancedAt as unknown as Json,
  };
  const { data: updated, error: updateErr } = await supabase
    .from("pipelines")
    .update(update)
    .eq("id", pipeline.id)
    // Re-assert the previous status so a concurrent transition can't race.
    .in("status", ["configuration", "ideation", "review", "generation"])
    .select()
    .single();
  if (updateErr || !updated) {
    return NextResponse.json(
      { error: updateErr?.message ?? "cancel update failed" },
      { status: 500 },
    );
  }

  // Emit the timeline event. Failure is non-fatal — the row is the
  // primary artifact and the dashboard re-derives state from it.
  const event: PipelineEventInsert = {
    pipeline_id: pipeline.id,
    kind: "stage_advanced",
    stage: "cancelled",
    payload: {
      reason: "operator_cancel",
      previous_status: previousStatus,
    } as Json,
  };
  const { error: evErr } = await supabase.from("pipeline_events").insert(event);
  if (evErr) {
    console.warn(`[pipelines.cancel] event insert failed: ${evErr.message}`);
  }

  return NextResponse.json({ pipeline: updated });
}
