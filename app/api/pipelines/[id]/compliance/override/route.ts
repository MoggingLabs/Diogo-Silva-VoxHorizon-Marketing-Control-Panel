import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/types.gen";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

type SupabaseClient = ReturnType<typeof createAdminClient>;

/**
 * Manager compliance-override input.
 *
 * `override_note` is the audited justification — REQUIRED and non-empty (an
 * unwritten hard-gate release is a compliance hole; the DB enforces it too via
 * the `creative_stage_state_override_requires_note` CHECK in migration 0018).
 * `decided_by` is the manager identity recorded on the override. `copy_variant_id`
 * is optional and rides along into the finding audit when the override targets a
 * specific copy variant.
 */
const ComplianceOverrideInput = z.object({
  creative_id: z.string().uuid(),
  override_note: z.string().trim().min(1, "override_note is required"),
  decided_by: z.string().trim().min(1).default("manager"),
  copy_variant_id: z.string().uuid().optional(),
});

/**
 * A `creative_stage_state` row read by name. The 0018 table is on `main` but
 * not yet applied to the live DB / `types.gen.ts`, so the generated `Database`
 * type doesn't know it — we cast at the `.from(...)` boundary.
 */
const STAGE = "compliance_review" as const;

/**
 * POST /api/pipelines/:id/compliance/override
 *
 * Manager-authed release of a HARD compliance block for ONE creative. The
 * operator/agent has no tool that writes a pass; only this audited human action
 * can move a `failed` compliance unit to `overridden`. (Access is gated at the
 * network/Tailscale layer + the trusted dashboard; the manager identity is
 * recorded in `decided_by`.)
 *
 * Contract:
 *   - 400 on malformed JSON.
 *   - 422 (validation) when `override_note` is missing/empty or ids are
 *     malformed — there is NO override without a written justification.
 *   - 404 when the pipeline or the compliance gate row doesn't exist.
 *   - 200 on success.
 *
 * Effects (mirrors the architecture's append-only audit, Layer 3):
 *   - `creative_stage_state(compliance_review)` for the creative →
 *     status='overridden', override_note, decided_by, decided_at stamped.
 *   - the original `failed` finding rows are RETAINED (append-only); the matching
 *     `compliance_finding` rows are marked `overridden` with the audit columns.
 *   - a `pipeline_events(kind='compliance_overridden')` audit row is emitted.
 *
 * Void-on-content-change is NOT this route's job — editing copy re-arms the
 * creative's compliance unit back to `pending` via the migration 0025 trigger.
 */
export async function POST(req: NextRequest, ctx: RouteContext) {
  const { id } = await ctx.params;

  // 1. Parse + validate the body. A missing/empty justification is a 422 — the
  //    central invariant of this route.
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = ComplianceOverrideInput.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation_failed", issues: parsed.error.issues },
      { status: 422 },
    );
  }
  const { creative_id, override_note, decided_by, copy_variant_id } = parsed.data;

  const supabase = createAdminClient();

  // 2. The pipeline must exist (so a bad id 404s instead of silently no-op'ing).
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

  // 3. The compliance gate row for this creative must exist (you can only
  //    override a unit the worker has seeded/adjudicated).
  const { data: stateRow, error: stateErr } = await supabase
    .from("creative_stage_state" as never)
    .select("id, status")
    .eq("pipeline_id" as never, id as never)
    .eq("creative_id" as never, creative_id as never)
    .eq("stage" as never, STAGE as never)
    .maybeSingle();
  if (stateErr) {
    return NextResponse.json({ error: stateErr.message }, { status: 500 });
  }
  if (!stateRow) {
    return NextResponse.json(
      { error: "compliance gate row not found for creative", creative_id },
      { status: 404 },
    );
  }

  const now = new Date().toISOString();

  // 4. Release the gate: status='overridden' + the required audit fields. The
  //    DB CHECK (0018) also enforces override_note presence — belt and braces.
  const { data: updated, error: updateErr } = await supabase
    .from("creative_stage_state" as never)
    .update({
      status: "overridden",
      override_note,
      decided_by,
      decided_at: now,
    } as never)
    .eq("pipeline_id" as never, id as never)
    .eq("creative_id" as never, creative_id as never)
    .eq("stage" as never, STAGE as never)
    .select()
    .single();
  if (updateErr || !updated) {
    return NextResponse.json(
      { error: updateErr?.message ?? "override update failed" },
      { status: 500 },
    );
  }

  // 5. Mark the matching findings as overridden (append-only audit: the original
  //    fail rows are retained, the override columns are stamped on them). Best-
  //    effort — the gate release above is the load-bearing state change.
  await markFindingsOverridden(supabase, {
    pipelineId: id,
    creativeId: creative_id,
    copyVariantId: copy_variant_id ?? null,
    decidedBy: decided_by,
    overrideNote: override_note,
    decidedAt: now,
  });

  // 6. Emit the permanent audit event so the dashboard's audit trail shows the
  //    override. Non-fatal — the row is the primary artifact.
  const { error: evErr } = await supabase.from("pipeline_events").insert({
    pipeline_id: id,
    kind: "compliance_overridden",
    stage: STAGE,
    payload: {
      creative_id,
      copy_variant_id: copy_variant_id ?? null,
      override_note,
      decided_by,
      decided_at: now,
    } as Json,
  });
  if (evErr) {
    console.warn(`[pipelines.compliance.override] event insert failed: ${evErr.message}`);
  }

  return NextResponse.json({
    ok: true,
    creative_id,
    status: "overridden",
    decided_by,
    decided_at: now,
  });
}

/**
 * Stamp the override audit columns on the creative's failing compliance
 * findings (append-only: the rows are not deleted, the original verdict is
 * retained). Scoped to the targeted copy variant when one is supplied. Failures
 * are swallowed — the `creative_stage_state` release is the source of truth the
 * gate predicate reads; the finding-level audit is a supporting record.
 */
async function markFindingsOverridden(
  supabase: SupabaseClient,
  args: {
    pipelineId: string;
    creativeId: string;
    copyVariantId: string | null;
    decidedBy: string;
    overrideNote: string;
    decidedAt: string;
  },
): Promise<void> {
  let query = supabase
    .from("compliance_finding" as never)
    .update({
      overridden: true,
      overridden_by: args.decidedBy,
      override_reason: args.overrideNote,
      overridden_at: args.decidedAt,
    } as never)
    .eq("pipeline_id" as never, args.pipelineId as never)
    .eq("creative_id" as never, args.creativeId as never)
    .eq("verdict" as never, "fail" as never);
  if (args.copyVariantId) {
    query = query.eq("copy_variant_id" as never, args.copyVariantId as never);
  }
  const { error } = await query;
  if (error) {
    console.warn(`[pipelines.compliance.override] finding audit update failed: ${error.message}`);
  }
}
