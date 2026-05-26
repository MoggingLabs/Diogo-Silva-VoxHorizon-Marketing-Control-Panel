import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { createAdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/lib/supabase/types.gen";
import type { VariantPlanCellRow, VariantPlanRow } from "@/lib/variant-plan/schemas";

type AdminClient = SupabaseClient<Database>;

/**
 * Load the latest active (non-deleted) `variant_plan` row for a pipeline, or
 * null. Shared by the variant-plan editor routes (E5.2 / #596) so they all
 * resolve "the" plan the same way (latest, deleted_at is null).
 */
export async function latestVariantPlan(
  supabase: AdminClient,
  pipelineId: string,
): Promise<VariantPlanRow | null> {
  const { data } = await supabase
    .from("variant_plan")
    .select("*")
    .eq("pipeline_id", pipelineId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as VariantPlanRow | null) ?? null;
}

/**
 * Resolve the plan AND assert the operator may edit its cells: an `approved`
 * plan is locked (the manager must re-open via a reject decision first). Returns
 * a discriminated union the route maps to HTTP.
 */
export type PlanGuard =
  | { kind: "ok"; plan: VariantPlanRow }
  | { kind: "missing" }
  | { kind: "locked" };

export async function resolveEditablePlan(
  supabase: AdminClient,
  pipelineId: string,
): Promise<PlanGuard> {
  const plan = await latestVariantPlan(supabase, pipelineId);
  if (!plan) return { kind: "missing" };
  if (plan.status === "approved") return { kind: "locked" };
  return { kind: "ok", plan };
}

export type VariantPlanEditorData = {
  plan: VariantPlanRow | null;
  cells: VariantPlanCellRow[];
  creatives: Array<{ id: string; concept: string | null }>;
  copyVariants: Array<{
    id: string;
    creative_id: string;
    headline: string | null;
    variant_index: number;
  }>;
};

/**
 * Everything the VariantPlanEditor (E5.2 / #596) needs in one server-side load:
 * the current plan + its cells (cell_index order), plus the pipeline's active
 * creatives + copy variants to populate the cell pickers. Used by the
 * variant_plan stage of the pipeline detail page.
 */
export async function getVariantPlanEditorData(pipelineId: string): Promise<VariantPlanEditorData> {
  const supabase = createAdminClient();

  const plan = await latestVariantPlan(supabase, pipelineId);

  const [cellsRes, creativesRes, copyRes] = await Promise.all([
    plan
      ? supabase
          .from("variant_plan_cell")
          .select("*")
          .eq("variant_plan_id", plan.id)
          .order("cell_index", { ascending: true })
      : Promise.resolve({ data: [] as VariantPlanCellRow[] }),
    supabase
      .from("creatives")
      .select("id, concept")
      .eq("pipeline_id", pipelineId)
      .is("deleted_at", null)
      .order("created_at", { ascending: true }),
    supabase
      .from("copy_variants")
      .select("id, creative_id, headline, variant_index")
      .eq("pipeline_id", pipelineId)
      .is("deleted_at", null)
      .order("creative_id", { ascending: true })
      .order("variant_index", { ascending: true }),
  ]);

  return {
    plan,
    cells: (cellsRes.data ?? []) as VariantPlanCellRow[],
    creatives: (creativesRes.data ?? []) as VariantPlanEditorData["creatives"],
    copyVariants: (copyRes.data ?? []) as VariantPlanEditorData["copyVariants"],
  };
}
