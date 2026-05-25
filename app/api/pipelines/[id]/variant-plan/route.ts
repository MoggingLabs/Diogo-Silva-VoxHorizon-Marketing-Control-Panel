import { type NextRequest } from "next/server";

import { badJson, conflict, emitEvent, ok, serverError, zodError } from "@/lib/crud";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/types.gen";
import { latestVariantPlan } from "@/lib/variant-plan/fetch";
import {
  VariantPlanUpsertInput,
  type VariantPlanInsert,
  type VariantPlanUpdate,
} from "@/lib/variant-plan/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * GET /api/pipelines/:id/variant-plan
 *
 * Read the current A/B plan + its cells (cell_index order) for the editor. The
 * variant_plan stage page seeds from here; the client refreshes it after cell
 * mutations. Returns `{ plan: null, cells: [] }` when no plan exists yet.
 */
export async function GET(_req: NextRequest, ctx: RouteContext) {
  const { id } = await ctx.params;
  const supabase = createAdminClient();

  const plan = await latestVariantPlan(supabase, id);
  if (!plan) return ok({ plan: null, cells: [] });

  const { data: cells, error } = await supabase
    .from("variant_plan_cell")
    .select("*")
    .eq("variant_plan_id", plan.id)
    .order("cell_index", { ascending: true });
  if (error) return serverError(error.message);

  return ok({ plan, cells: cells ?? [] });
}

/**
 * PUT /api/pipelines/:id/variant-plan
 *
 * Upsert the plan's draft fields (test_variable + hypothesis), creating the row
 * when absent (E5.2 / #596). The status / approval is OWNED by the
 * `variant-plan/decision` route — this editor never touches status. A plan that
 * is already `approved` is locked: we return 409 so the manager re-opens it via
 * a reject decision before editing. Emits a non-fatal audit event.
 */
export async function PUT(req: NextRequest, ctx: RouteContext) {
  const { id } = await ctx.params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return badJson();
  }

  const parsed = VariantPlanUpsertInput.safeParse(body);
  if (!parsed.success) return zodError(parsed.error);

  const supabase = createAdminClient();
  const existing = await latestVariantPlan(supabase, id);

  if (existing && existing.status === "approved") {
    return conflict("plan_locked", { reason: "an approved plan must be re-opened before editing" });
  }

  if (existing) {
    const update: VariantPlanUpdate = {
      test_variable: parsed.data.test_variable,
      hypothesis: parsed.data.hypothesis ?? null,
    };
    const { data: plan, error } = await supabase
      .from("variant_plan")
      .update(update)
      .eq("id", existing.id)
      .select()
      .single();
    if (error || !plan) return serverError(error?.message ?? "update failed");

    await emitEvent(supabase, {
      kind: "variant_plan_updated",
      refTable: "variant_plan",
      refId: plan.id,
      payload: parsed.data as unknown as Json,
    });
    return ok({ plan });
  }

  const insert: VariantPlanInsert = {
    pipeline_id: id,
    test_variable: parsed.data.test_variable,
    hypothesis: parsed.data.hypothesis ?? null,
    status: "draft",
  };
  const { data: plan, error } = await supabase
    .from("variant_plan")
    .insert(insert)
    .select()
    .single();
  if (error || !plan) return serverError(error?.message ?? "insert failed");

  await emitEvent(supabase, {
    kind: "variant_plan_created",
    refTable: "variant_plan",
    refId: plan.id,
    payload: parsed.data as unknown as Json,
  });
  return ok({ plan }, { status: 201 });
}
