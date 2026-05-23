import "server-only";

import type { CopyVariantView } from "@/components/copy/CopyComposer";
import { getSignedUrl, type Creative } from "@/lib/creatives";
import type { GridCreative, StageStateRow } from "@/lib/review/grid";
import type { LaunchCopyVariant } from "@/lib/review/grid";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Server-side fetch helpers for the per-creative review surfaces (P4.2–P4.6).
 *
 * Frontend reads go through the service-role client (RLS is deny-all on the new
 * tables, per the 0011 lockdown), so these helpers run in Server Components /
 * route handlers only — never the browser. They project the raw rows into the
 * narrow shapes the grid + gates consume (`lib/review/grid.ts`).
 */

export type ReviewBundle = {
  creatives: GridCreative[];
  states: StageStateRow[];
  copyVariants: LaunchCopyVariant[];
  /** Signed preview URL per creative id (null when unavailable). */
  signedUrls: Record<string, string | null>;
};

type CreativeRow = Pick<Creative, "id" | "concept" | "status" | "file_path_supabase">;

/**
 * Load every creative for a pipeline + its per-creative gate state + copy
 * variants, ready for the CreativeReviewGrid / launch preconditions. Killed +
 * soft-deleted creatives are still returned (the grid greys killed ones and
 * drops them from the rollup scope); deleted rows are filtered out.
 */
export async function getReviewBundle(pipelineId: string): Promise<ReviewBundle> {
  const supabase = createAdminClient();

  const { data: creativeRows } = await supabase
    .from("creatives")
    .select("id, concept, status, file_path_supabase")
    .eq("pipeline_id", pipelineId)
    .is("deleted_at", null)
    .order("created_at", { ascending: true });

  const creatives: GridCreative[] = (creativeRows ?? []).map((c: CreativeRow) => ({
    id: c.id,
    concept: c.concept,
    status: c.status,
  }));

  const { data: stateRows } = await supabase
    .from("creative_stage_state")
    .select("creative_id, stage, status, override_note, summary")
    .eq("pipeline_id", pipelineId);

  const states: StageStateRow[] = (stateRows ?? []) as StageStateRow[];

  const { data: copyRows } = await supabase
    .from("copy_variants")
    .select("creative_id, status")
    .eq("pipeline_id", pipelineId);

  const copyVariants: LaunchCopyVariant[] = (copyRows ?? []) as LaunchCopyVariant[];

  // Resolve signed preview URLs (best-effort; null when missing).
  const signedUrls: Record<string, string | null> = {};
  await Promise.all(
    (creativeRows ?? []).map(async (c: CreativeRow) => {
      signedUrls[c.id] = await getSignedUrl(supabase, c.file_path_supabase);
    }),
  );

  return { creatives, states, copyVariants, signedUrls };
}

/**
 * Load the full copy-variant rows for a pipeline as the CopyComposer's view
 * shape (#359). Ordered by creative then variant index for a stable editor.
 */
export async function getCopyVariants(pipelineId: string): Promise<CopyVariantView[]> {
  const supabase = createAdminClient();
  const { data } = await supabase
    .from("copy_variants")
    .select(
      "id, creative_id, platform, placement, variant_index, headline, body, description, cta, humanized, status",
    )
    .eq("pipeline_id", pipelineId)
    .order("creative_id", { ascending: true })
    .order("variant_index", { ascending: true });
  return (data ?? []) as CopyVariantView[];
}

/**
 * Load the latest variant_plan + its cells for a pipeline (variant_plan stage).
 * Returns null when no plan has been authored yet.
 */
export async function getVariantPlan(pipelineId: string): Promise<{
  test_variable: string | null;
  hypothesis: string | null;
  cells: Array<{
    id: string;
    cell_index: number;
    label: string | null;
    creative_id: string | null;
    copy_variant_id: string | null;
  }>;
} | null> {
  const supabase = createAdminClient();
  const { data: plan } = await supabase
    .from("variant_plan")
    .select("id, test_variable, hypothesis")
    .eq("pipeline_id", pipelineId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!plan) return null;

  const { data: cells } = await supabase
    .from("variant_plan_cell")
    .select("id, cell_index, label, creative_id, copy_variant_id")
    .eq("variant_plan_id", plan.id)
    .order("cell_index", { ascending: true });

  return {
    test_variable: plan.test_variable,
    hypothesis: plan.hypothesis,
    cells: cells ?? [],
  };
}

/** The client's CPL target for the monitor thresholds, or null. */
export async function getClientCplTarget(clientId: string | null): Promise<number | null> {
  if (!clientId) return null;
  const supabase = createAdminClient();
  const { data } = await supabase
    .from("clients")
    .select("cpl_target")
    .eq("id", clientId)
    .maybeSingle();
  return data?.cpl_target ?? null;
}
