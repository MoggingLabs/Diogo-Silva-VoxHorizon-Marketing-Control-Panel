import { NextResponse, type NextRequest } from "next/server";

import { estimatePipelineCost } from "@/lib/cost-estimator";
import { isOperatorDriven, operatorInstruction } from "@/lib/operator/dispatch";
import {
  ReviewDecisionInput,
  type PipelineEventInsert,
  type PipelineUpdate,
} from "@/lib/pipeline/schemas";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/types.gen";
import { enqueueWorkItem } from "@/lib/work-queue/enqueue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * POST /api/pipelines/:id/review/decision
 *
 * Review-stage approval gate. The operator submits one of three decisions:
 *
 *   - `approved`              → pipeline.status = `generation`, no notes required.
 *   - `approved_with_changes` → pipeline.status = `generation`, notes required.
 *   - `rejected`              → pipeline.status = `cancelled`, notes required.
 *
 * Side-effects on approve / approve-with-changes:
 *   - Snapshots `pipelines.cost_estimate` from `estimatePipelineCost()` using
 *     the same inputs the review-stage UI displays (format + picked counts).
 *   - Stamps `approval = { decision, notes, decided_at }`.
 *   - Stamps `advanced_at.generation = now()`.
 *   - Emits `pipeline_events(kind='stage_advanced', stage='generation', payload={decision})`.
 *   - Best-effort POST to the worker's `/work/hermes/kanban` bridge to
 *     create a generation task assigned to `ekko`. Failures (incl. 404
 *     when the worker isn't reachable) are swallowed so a transient
 *     outage doesn't block the commit.
 *
 * Side-effects on reject:
 *   - Stamps `approval = { decision, notes, decided_at }`.
 *   - Sets `status = 'cancelled'`.
 *   - Emits `pipeline_events(kind='stage_advanced', stage='cancelled', payload={decision, notes})`.
 *
 * Status guard: if `pipelines.status !== 'review'` the route returns 409 so a
 * double-submit or out-of-order navigation can't promote a pipeline twice.
 */
export async function POST(req: NextRequest, ctx: RouteContext) {
  const { id } = await ctx.params;

  // 1. Parse + validate body.
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = ReviewDecisionInput.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation_failed", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const { decision, notes } = parsed.data;

  // 2. Load the pipeline + status guard.
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
  if (pipeline.status !== "review") {
    return NextResponse.json(
      { error: "invalid_state", current: pipeline.status, expected: "review" },
      { status: 409 },
    );
  }

  const now = new Date().toISOString();
  const approval = {
    decision,
    notes: notes ?? null,
    decided_at: now,
  };

  // 3. Reject branch -- terminal, no cost snapshot or worker kick.
  //    Silent-failure PR-3 cutover: stop writing `pipelines.status` -- the
  //    `pipeline_cancelled` event drives the reducer (cancelled is the
  //    terminal escape in `compute_pipeline_status`) AND fires the
  //    cancel-propagate trigger from migration 0050 so any in-flight
  //    operator dispatch is cancelled alongside.
  if (decision === "rejected") {
    const update: PipelineUpdate = {
      approval: approval as unknown as Json,
    };
    const { error: updateErr } = await supabase
      .from("pipelines")
      .update(update)
      .eq("id", pipeline.id)
      .eq("status", "review");
    if (updateErr) {
      return NextResponse.json(
        { error: updateErr.message ?? "reject update failed" },
        { status: 500 },
      );
    }

    const event: PipelineEventInsert = {
      pipeline_id: pipeline.id,
      kind: "pipeline_cancelled",
      stage: "cancelled",
      payload: { decision, notes: notes ?? null, reason: "review_rejected" } as Json,
    };
    const { error: evErr } = await supabase.from("pipeline_events").insert(event);
    if (evErr) {
      return NextResponse.json(
        { error: `pipeline_cancelled event insert failed: ${evErr.message}` },
        { status: 500 },
      );
    }

    // Synthesise the response (the reducer derives `cancelled` from the
    // pipeline_cancelled event we just emitted).
    const synthesised = {
      ...pipeline,
      status: "cancelled",
      approval: approval as unknown as Json,
    };
    return NextResponse.json({ pipeline: synthesised });
  }

  // 4. Approve / approve_with_changes — compute cost estimate from the live
  //    picks and format, then transition to `generation`.
  const picks = (pipeline.picks ?? {}) as { image?: string[]; video?: string[] };
  const pickedImageCount = Array.isArray(picks.image) ? picks.image.length : 0;
  const pickedVideoCount = Array.isArray(picks.video) ? picks.video.length : 0;

  const estimate = estimatePipelineCost({
    format: pipeline.format_choice,
    picked_image_count: pickedImageCount,
    picked_video_count: pickedVideoCount,
    estimated_chat_iterations: 1,
  });

  // Stamp `advanced_at.generation` without clobbering earlier stage marks.
  const advancedAt =
    pipeline.advanced_at &&
    typeof pipeline.advanced_at === "object" &&
    !Array.isArray(pipeline.advanced_at)
      ? (pipeline.advanced_at as Record<string, string>)
      : {};
  const nextAdvancedAt = { ...advancedAt, generation: now };

  // Silent-failure PR-3 cutover: stop writing `pipelines.status` -- the
  // reducer derives it from the `stage_advanced` event we emit below. The
  // other columns (approval snapshot, cost_estimate, advanced_at.generation)
  // remain the route's job.
  const update: PipelineUpdate = {
    approval: approval as unknown as Json,
    cost_estimate: estimate as unknown as Json,
    advanced_at: nextAdvancedAt as unknown as Json,
  };
  const { error: updateErr } = await supabase
    .from("pipelines")
    .update(update)
    .eq("id", pipeline.id)
    .eq("status", "review");
  if (updateErr) {
    return NextResponse.json(
      { error: updateErr.message ?? "approve update failed" },
      { status: 500 },
    );
  }

  // Emit the stage_advanced event -- the reducer's load-bearing input. No
  // longer swallowed: a failed insert means the derived status stays stale.
  const event: PipelineEventInsert = {
    pipeline_id: pipeline.id,
    kind: "stage_advanced",
    stage: "generation",
    payload: { decision } as Json,
  };
  const { error: evErr } = await supabase.from("pipeline_events").insert(event);
  if (evErr) {
    return NextResponse.json(
      { error: `stage_advanced event insert failed: ${evErr.message}` },
      { status: 500 },
    );
  }

  // Hand generation off to exactly one executor via the work_item queue.
  // The auto-emit trigger writes the `operator_dispatched` / `task_queued`
  // events the panel reads; the daemon/worker pulls the queued row. The
  // legacy fire-and-forget kicks and the explicit `operator_dispatched`
  // event insert are gone (PR-3 cutover).
  if (isOperatorDriven(pipeline.config_draft)) {
    // Operator-driven: the Hermes operator renders the finals for the picked
    // concepts (its render call is the per-batch spend gate).
    const instruction = operatorInstruction("generation", pipeline.id);
    try {
      await enqueueWorkItem({
        kind: "operator_dispatch",
        pipelineId: pipeline.id,
        payload: { instruction, stage: "generation" },
        idempotencyKey: `op-disp:${pipeline.id}:generation:review_approved`,
        createdBy: "api/pipelines/review/decision",
      });
    } catch (e) {
      return NextResponse.json(
        { error: `work_item enqueue failed: ${String(e)}` },
        { status: 500 },
      );
    }
  } else {
    // Regular: the deterministic worker renders the final 1:1 + 9:16 assets
    // for every Review pick. The auto-emit trigger writes the task_queued /
    // task_done events the StageGeneration UI reads.
    try {
      await enqueueWorkItem({
        kind: "worker_generation",
        pipelineId: pipeline.id,
        payload: { stage: "generation" },
        idempotencyKey: `wg:${pipeline.id}:generation`,
        createdBy: "api/pipelines/review/decision",
      });
    } catch (e) {
      return NextResponse.json(
        { error: `work_item enqueue failed: ${String(e)}` },
        { status: 500 },
      );
    }
  }

  // Synthesise the response (silent-failure PR-3: the reducer derives the
  // same on read).
  const synthesised = {
    ...pipeline,
    status: "generation",
    approval: approval as unknown as Json,
    cost_estimate: estimate as unknown as Json,
    advanced_at: nextAdvancedAt as unknown as Json,
  };
  return NextResponse.json({ pipeline: synthesised });
}

// Silent-failure PR-3 cutover: the legacy `fireWorkerGeneration` fire-and-forget
// helper was removed -- the worker polls the work_item queue (kind =
// worker_generation) instead of accepting a direct HTTP kick.
