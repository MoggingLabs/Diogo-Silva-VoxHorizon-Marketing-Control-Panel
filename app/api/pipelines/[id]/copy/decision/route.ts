import { NextResponse, type NextRequest } from "next/server";

import { CopyDecisionInput, type CopyVariantUpdate } from "@/lib/copy/schemas";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * POST /api/pipelines/:id/copy/decision
 *
 * Approve or reject a single copy variant in the copy stage (#359, P4.4).
 *   - `approved` → status = approved, approved_by/at stamped.
 *   - `rejected` → status = rejected, decided_notes stamped (notes required).
 *
 * Guards the pipeline is in the `copy` stage (409 otherwise). The ≥3-approved
 * launch precondition is enforced at the launch gate (`lib/review/grid.ts`);
 * this route only records one variant's verdict.
 */
export async function POST(req: NextRequest, ctx: RouteContext) {
  const { id } = await ctx.params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = CopyDecisionInput.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation_failed", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const { id: variantId, decision, notes } = parsed.data;

  const supabase = createAdminClient();

  const { data: pipeline, error: readErr } = await supabase
    .from("pipelines")
    .select("id, status")
    .eq("id", id)
    .maybeSingle();
  if (readErr) {
    return NextResponse.json({ error: readErr.message }, { status: 500 });
  }
  if (!pipeline) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  if (pipeline.status !== "copy") {
    return NextResponse.json(
      { error: "invalid_state", current: pipeline.status, expected: "copy" },
      { status: 409 },
    );
  }

  const now = new Date().toISOString();
  const update: CopyVariantUpdate =
    decision === "approved"
      ? {
          status: "approved",
          approved_by: "operator",
          approved_at: now,
          decided_notes: notes ?? null,
          updated_at: now,
        }
      : {
          status: "rejected",
          decided_notes: notes ?? null,
          updated_at: now,
        };

  const { data: updated, error: updateErr } = await supabase
    .from("copy_variants")
    .update(update)
    .eq("id", variantId)
    .eq("pipeline_id", id)
    .select()
    .single();
  if (updateErr || !updated) {
    return NextResponse.json(
      { error: updateErr?.message ?? "copy decision update failed" },
      { status: 500 },
    );
  }

  return NextResponse.json({ variant: updated });
}
