import { type NextRequest } from "next/server";

import { badJson, conflict, created, emitEvent, notFound, serverError, zodError } from "@/lib/crud";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/types.gen";
import { resolveEditablePlan } from "@/lib/variant-plan/fetch";
import { VariantPlanCellCreateInput, type VariantPlanCellInsert } from "@/lib/variant-plan/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * POST /api/pipelines/:id/variant-plan/cells
 *
 * Add one A/B test cell to the pipeline's plan (E5.2 / #596). The plan must
 * already exist (PUT the plan first) and must NOT be approved (409 plan_locked
 * — an approved plan is re-opened via a reject decision before editing). When
 * `cell_index` is omitted the route appends at the next free index. The unique
 * (variant_plan_id, cell_index) constraint surfaces a duplicate index as 409.
 */
export async function POST(req: NextRequest, ctx: RouteContext) {
  const { id } = await ctx.params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return badJson();
  }

  const parsed = VariantPlanCellCreateInput.safeParse(body);
  if (!parsed.success) return zodError(parsed.error);

  const supabase = createAdminClient();
  const guard = await resolveEditablePlan(supabase, id);
  if (guard.kind === "missing") {
    return notFound("plan_not_found");
  }
  if (guard.kind === "locked") {
    return conflict("plan_locked", { reason: "an approved plan must be re-opened before editing" });
  }
  const plan = guard.plan;

  // Resolve the cell index: explicit, or next free (max + 1).
  let cellIndex = parsed.data.cell_index;
  if (cellIndex === undefined) {
    const { data: last } = await supabase
      .from("variant_plan_cell")
      .select("cell_index")
      .eq("variant_plan_id", plan.id)
      .order("cell_index", { ascending: false })
      .limit(1)
      .maybeSingle();
    cellIndex = ((last?.cell_index as number | undefined) ?? -1) + 1;
  }

  const insert: VariantPlanCellInsert = {
    variant_plan_id: plan.id,
    cell_index: cellIndex,
    creative_id: parsed.data.creative_id ?? null,
    copy_variant_id: parsed.data.copy_variant_id ?? null,
    audience: (parsed.data.audience ?? null) as Json,
    label: parsed.data.label ?? null,
  };

  const { data: cell, error } = await supabase
    .from("variant_plan_cell")
    .insert(insert)
    .select()
    .single();
  if (error) {
    // Unique (variant_plan_id, cell_index) collision -> 409.
    if (error.code === "23505" || /duplicate key|unique/i.test(error.message)) {
      return conflict("duplicate_cell_index", { cell_index: cellIndex });
    }
    return serverError(error.message);
  }

  await emitEvent(supabase, {
    kind: "variant_plan_cell_created",
    refTable: "variant_plan_cell",
    refId: cell.id,
    payload: { variant_plan_id: plan.id, cell_index: cellIndex } as Json,
  });

  return created({ cell });
}
