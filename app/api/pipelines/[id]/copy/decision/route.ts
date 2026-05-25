import { NextResponse, type NextRequest } from "next/server";

import {
  CopyDecisionInput,
  type CopyVariantUpdate,
  type VideoCopyVariantUpdate,
} from "@/lib/copy/schemas";
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
 * Format-aware (Phase 2 / B2): an image creative's variant lives in
 * `copy_variants`, a VIDEO creative's variant lives in `video_copy_variants`
 * (the parity table from migration 0031). We try the image table first (the
 * live production path, byte-identical), and only when the id is not an image
 * variant do we update the video table, so the SAME endpoint + request shape
 * `{ id, decision, notes? }` records a verdict for either format.
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

  // Image path first (live production behaviour, unchanged). `maybeSingle` so a
  // non-image variant id returns no row (data:null, error:null) instead of a
  // not-found error; we then route it to the video table below. A real DB error
  // on the image update still surfaces as a 500.
  const { data: imageUpdated, error: imageErr } = await supabase
    .from("copy_variants")
    .update(update)
    .eq("id", variantId)
    .eq("pipeline_id", id)
    .select()
    .maybeSingle();
  if (imageErr) {
    return NextResponse.json({ error: imageErr.message }, { status: 500 });
  }
  if (imageUpdated) {
    return NextResponse.json({ variant: imageUpdated });
  }

  // Video path (B2): the id is not an image variant, so it belongs to a video
  // creative. `video_copy_variants` (migration 0031) has no approved_by /
  // approved_at / decided_notes columns; it carries status + updated_at, so we
  // write only the format-appropriate subset (the approve/reject verdict).
  const videoUpdate: VideoCopyVariantUpdate =
    decision === "approved"
      ? { status: "approved", updated_at: now }
      : { status: "rejected", updated_at: now };

  const { data: videoUpdated, error: videoErr } = await supabase
    .from("video_copy_variants")
    .update(videoUpdate)
    .eq("id", variantId)
    .select()
    .single();
  if (videoErr || !videoUpdated) {
    return NextResponse.json(
      { error: videoErr?.message ?? "copy decision update failed" },
      { status: 500 },
    );
  }

  return NextResponse.json({ variant: videoUpdated });
}
