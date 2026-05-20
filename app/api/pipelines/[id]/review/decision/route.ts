import { NextResponse, type NextRequest } from "next/server";

import { estimatePipelineCost } from "@/lib/cost-estimator";
import {
  ReviewDecisionInput,
  type PipelineEventInsert,
  type PipelineUpdate,
} from "@/lib/pipeline/schemas";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/types.gen";

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

  // 3. Reject branch — terminal, no cost snapshot or worker kick.
  if (decision === "rejected") {
    const update: PipelineUpdate = {
      status: "cancelled",
      approval: approval as unknown as Json,
    };
    const { data: updated, error: updateErr } = await supabase
      .from("pipelines")
      .update(update)
      .eq("id", pipeline.id)
      .eq("status", "review")
      .select()
      .single();
    if (updateErr || !updated) {
      return NextResponse.json(
        { error: updateErr?.message ?? "reject update failed" },
        { status: 500 },
      );
    }

    const event: PipelineEventInsert = {
      pipeline_id: pipeline.id,
      kind: "stage_advanced",
      stage: "cancelled",
      payload: { decision, notes: notes ?? null } as Json,
    };
    const { error: evErr } = await supabase.from("pipeline_events").insert(event);
    if (evErr) {
      console.warn(`[pipelines.review.decision] event insert failed: ${evErr.message}`);
    }

    return NextResponse.json({ pipeline: updated });
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

  const update: PipelineUpdate = {
    status: "generation",
    approval: approval as unknown as Json,
    cost_estimate: estimate as unknown as Json,
    advanced_at: nextAdvancedAt as unknown as Json,
  };
  const { data: updated, error: updateErr } = await supabase
    .from("pipelines")
    .update(update)
    .eq("id", pipeline.id)
    .eq("status", "review")
    .select()
    .single();
  if (updateErr || !updated) {
    return NextResponse.json(
      { error: updateErr?.message ?? "approve update failed" },
      { status: 500 },
    );
  }

  // Emit the timeline event. Failure is non-fatal — the row is the
  // primary artifact and the dashboard re-derives state from it.
  const event: PipelineEventInsert = {
    pipeline_id: pipeline.id,
    kind: "stage_advanced",
    stage: "generation",
    payload: { decision } as Json,
  };
  const { error: evErr } = await supabase.from("pipeline_events").insert(event);
  if (evErr) {
    console.warn(`[pipelines.review.decision] event insert failed: ${evErr.message}`);
  }

  // Fire-and-forget worker kick to the image-generation pipeline:
  // POST /work/pipeline/generation renders the final 1:1 + 9:16 assets for
  // every Review pick (restored in feat/restore-image-generation). This is
  // the approval gate for generation — the operator approving here is what
  // fires the worker; the per-tool Ekko ApprovalModal does NOT gate it. The
  // worker emits the task_queued/running/done/error + cost_recorded
  // pipeline_events the StageGeneration UI reads. Failures are swallowed so
  // a worker outage doesn't block the commit.
  void fireWorkerGeneration(pipeline.id).catch((e) => {
    console.warn(
      `[pipelines.review.decision] worker generation kick failed for ${pipeline.id}: ${String(e)}`,
    );
  });

  return NextResponse.json({ pipeline: updated });
}

/**
 * Fire-and-forget POST to the worker's image-generation endpoint
 * (`/work/pipeline/generation`). Mirrors the advance route's
 * `fireWorkerIdeation` so the call shape is consistent: the worker reads the
 * picks + format off the pipeline row keyed by `pipeline_id`, so the body is
 * just the id. If the worker isn't configured (WORKER_URL /
 * WORKER_SHARED_SECRET unset) we skip, and a 404 is swallowed silently.
 */
async function fireWorkerGeneration(pipelineId: string): Promise<void> {
  const base = process.env.WORKER_URL?.replace(/\/$/, "");
  const secret = process.env.WORKER_SHARED_SECRET;
  if (!base || !secret) return;
  const res = await fetch(`${base}/work/pipeline/generation`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secret}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ pipeline_id: pipelineId }),
    cache: "no-store",
  });
  if (!res.ok && res.status !== 404) {
    const text = await res.text().catch(() => "");
    throw new Error(`worker /work/pipeline/generation -> ${res.status}: ${text.slice(0, 200)}`);
  }
}
