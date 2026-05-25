import { type NextRequest } from "next/server";

import {
  badJson,
  conflict,
  emitEvent,
  hardDelete,
  notFound,
  ok,
  serverError,
  zodError,
} from "@/lib/crud";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/types.gen";
import { resolveEditablePlan } from "@/lib/variant-plan/fetch";
import {
  VariantPlanCellUpdateInput,
  type VariantPlanCellRow,
  type VariantPlanCellUpdate,
} from "@/lib/variant-plan/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string; cellId: string }> };

/**
 * Resolve the editable plan for this pipeline AND confirm the cell belongs to
 * it. Centralises the guard shared by PATCH + DELETE: a missing/locked plan, or
 * a cell that is not under this pipeline's plan, short-circuits with the right
 * status.
 */
type GuardResult =
  | { ok: true; planId: string }
  | { ok: false; response: ReturnType<typeof notFound> };

async function guardCell(
  supabase: ReturnType<typeof createAdminClient>,
  pipelineId: string,
  cellId: string,
): Promise<GuardResult> {
  const guard = await resolveEditablePlan(supabase, pipelineId);
  if (guard.kind === "missing") return { ok: false, response: notFound("plan_not_found") };
  if (guard.kind === "locked") {
    return {
      ok: false,
      response: conflict("plan_locked", {
        reason: "an approved plan must be re-opened before editing",
      }),
    };
  }
  const { data: cell } = await supabase
    .from("variant_plan_cell")
    .select("id, variant_plan_id")
    .eq("id", cellId)
    .maybeSingle();
  if (!cell || cell.variant_plan_id !== guard.plan.id) {
    return { ok: false, response: notFound("cell_not_found") };
  }
  return { ok: true, planId: guard.plan.id };
}

/**
 * PATCH /api/pipelines/:id/variant-plan/cells/:cellId
 *
 * Edit one A/B cell (creative / copy_variant / audience / label / index) of a
 * non-approved plan (E5.2 / #596). 404 if the cell isn't under this pipeline's
 * plan; 409 if the plan is approved (locked). A duplicate cell_index is 409.
 */
export async function PATCH(req: NextRequest, ctx: RouteContext) {
  const { id, cellId } = await ctx.params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return badJson();
  }

  const parsed = VariantPlanCellUpdateInput.safeParse(body);
  if (!parsed.success) return zodError(parsed.error);

  const supabase = createAdminClient();
  const guard = await guardCell(supabase, id, cellId);
  if (!guard.ok) return guard.response;

  const update: VariantPlanCellUpdate = {};
  if (parsed.data.cell_index !== undefined) update.cell_index = parsed.data.cell_index;
  if (parsed.data.creative_id !== undefined) update.creative_id = parsed.data.creative_id;
  if (parsed.data.copy_variant_id !== undefined)
    update.copy_variant_id = parsed.data.copy_variant_id;
  if (parsed.data.audience !== undefined) update.audience = (parsed.data.audience ?? null) as Json;
  if (parsed.data.label !== undefined) update.label = parsed.data.label;

  const { data: cell, error } = await supabase
    .from("variant_plan_cell")
    .update(update)
    .eq("id", cellId)
    .select()
    .single();
  if (error) {
    if (error.code === "23505" || /duplicate key|unique/i.test(error.message)) {
      return conflict("duplicate_cell_index", { cell_index: parsed.data.cell_index });
    }
    return serverError(error.message);
  }

  await emitEvent(supabase, {
    kind: "variant_plan_cell_updated",
    refTable: "variant_plan_cell",
    refId: cellId,
    payload: parsed.data as unknown as Json,
  });

  return ok({ cell });
}

/**
 * DELETE /api/pipelines/:id/variant-plan/cells/:cellId
 *
 * Remove one A/B cell. A cell is a PURE child config row (cascade from the
 * plan, no `deleted_at` tombstone), so per the plan's "hard-delete only for pure
 * child config rows" this is a real delete (E5.2 / #596). 404 if the cell isn't
 * under this pipeline's plan; 409 if the plan is approved (locked).
 */
export async function DELETE(_req: NextRequest, ctx: RouteContext) {
  const { id, cellId } = await ctx.params;
  const supabase = createAdminClient();

  const guard = await guardCell(supabase, id, cellId);
  if (!guard.ok) return guard.response;

  const result = await hardDelete<VariantPlanCellRow>(supabase, "variant_plan_cell", cellId);
  switch (result.kind) {
    case "ok":
      await emitEvent(supabase, {
        kind: "variant_plan_cell_deleted",
        refTable: "variant_plan_cell",
        refId: cellId,
        payload: { variant_plan_id: guard.planId } as Json,
      });
      return ok({ cell: result.row });
    case "missing":
      return notFound("cell_not_found");
    case "conflict":
      return conflict(result.reason);
    case "error":
      return serverError(result.message);
  }
}
