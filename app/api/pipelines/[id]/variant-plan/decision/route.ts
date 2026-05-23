import { NextResponse, type NextRequest } from "next/server";

import { VariantPlanDecisionInput } from "@/lib/pipeline/decision-schemas";
import { type PipelineEventInsert, type PipelineUpdate } from "@/lib/pipeline/schemas";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/types.gen";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * POST /api/pipelines/:id/variant-plan/decision
 *
 * Manager approves / rejects the A/B test plan in the `variant_plan` stage.
 *   - `approved` → pipeline.status = `finalize_assets`, advanced_at stamped,
 *     the latest variant_plan row marked `approved`.
 *   - `rejected` → stays in `variant_plan`; the variant_plan row marked
 *     `rejected` so the operator re-plans (notes required).
 *
 * Status guard: 409 unless the pipeline is in `variant_plan`.
 */
export async function POST(req: NextRequest, ctx: RouteContext) {
  const { id } = await ctx.params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = VariantPlanDecisionInput.safeParse(body);
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
  if (pipeline.status !== "variant_plan") {
    return NextResponse.json(
      { error: "invalid_state", current: pipeline.status, expected: "variant_plan" },
      { status: 409 },
    );
  }

  const now = new Date().toISOString();

  // Mark the latest variant_plan row's verdict (best-effort — the row may not
  // exist if the operator hasn't persisted a plan yet).
  const { error: planErr } = await supabase
    .from("variant_plan")
    .update({
      status: decision,
      approved_by: decision === "approved" ? "operator" : null,
      approved_at: decision === "approved" ? now : null,
      notes: notes ?? null,
      updated_at: now,
    })
    .eq("pipeline_id", id);
  if (planErr) {
    console.warn(`[pipelines.variant-plan.decision] plan update failed: ${planErr.message}`);
  }

  if (decision === "rejected") {
    // Stays in variant_plan — record the rejection on the timeline only.
    const event: PipelineEventInsert = {
      pipeline_id: id,
      kind: "variant_plan_rejected",
      stage: "variant_plan",
      payload: { notes: notes ?? null } as Json,
    };
    const { error: evErr } = await supabase.from("pipeline_events").insert(event);
    if (evErr) {
      console.warn(`[pipelines.variant-plan.decision] event insert failed: ${evErr.message}`);
    }
    return NextResponse.json({ pipeline, decision });
  }

  // Approve → advance to finalize_assets.
  const advancedAt =
    pipeline.advanced_at &&
    typeof pipeline.advanced_at === "object" &&
    !Array.isArray(pipeline.advanced_at)
      ? (pipeline.advanced_at as Record<string, string>)
      : {};
  const update: PipelineUpdate = {
    status: "finalize_assets",
    advanced_at: { ...advancedAt, finalize_assets: now } as unknown as Json,
  };
  const { data: updated, error: updateErr } = await supabase
    .from("pipelines")
    .update(update)
    .eq("id", id)
    .eq("status", "variant_plan")
    .select()
    .single();
  if (updateErr || !updated) {
    return NextResponse.json(
      { error: updateErr?.message ?? "variant plan advance failed" },
      { status: 500 },
    );
  }

  const event: PipelineEventInsert = {
    pipeline_id: id,
    kind: "stage_advanced",
    stage: "finalize_assets",
    payload: { decision } as Json,
  };
  const { error: evErr } = await supabase.from("pipeline_events").insert(event);
  if (evErr) {
    console.warn(`[pipelines.variant-plan.decision] event insert failed: ${evErr.message}`);
  }

  return NextResponse.json({ pipeline: updated, decision });
}
