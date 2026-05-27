/**
 * Silent-failure foundational redesign, PR-4 helper.
 *
 * `pipelines.status` was dropped in migration 0051. The canonical answer to
 * "what stage is this pipeline in?" is now the event-sourced reducer
 * `compute_pipeline_status(id)` (migration 0050), which folds the
 * `pipeline_events` timeline into the current `pipeline_status_enum` value.
 *
 * This module is the ONE seam every route uses to:
 *   1. Read the derived status of a pipeline (status guard checks).
 *   2. Hydrate a pipeline row's `status` field for the UI types -- the
 *      `Pipeline` curated view model still carries `status` because the UI
 *      stepper / badges / routing in `app/pipeline/[id]/page.tsx` switch on
 *      it; we populate it server-side from the reducer before returning.
 *
 * Implementation: a single RPC round-trip via `compute_pipeline_status`. The
 * function is `stable` so the planner can inline it under a transactional
 * read; under the service-role client we just call it as an RPC.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/types.gen";
import type { PipelineStatus } from "@/lib/pipeline/types";

type AdminLikeClient = SupabaseClient<Database>;

/**
 * Resolve the derived status of one pipeline via the reducer RPC. Returns
 * `null` when the pipeline id is unknown -- callers should treat that as a
 * 404. The RPC itself never throws for a missing id; it returns
 * `'configuration'` for an empty event timeline, so we cannot distinguish
 * "no pipeline" from "no events yet" through it alone. Callers that need
 * the distinction should pair this with a `select id from pipelines` check.
 */
export async function getDerivedStatus(
  supabase: AdminLikeClient,
  pipelineId: string,
): Promise<PipelineStatus | null> {
  const { data, error } = await supabase.rpc("compute_pipeline_status", {
    p_pipeline_id: pipelineId,
  });
  if (error) {
    throw new Error(`compute_pipeline_status(${pipelineId}) failed: ${error.message}`);
  }
  // The RPC returns the enum directly. Treat an explicit null as missing.
  return (data ?? null) as PipelineStatus | null;
}

/**
 * Inject `status` into a pipeline row read directly from the `pipelines`
 * table after migration 0051 dropped the column. The caller has already
 * read the row (any reasonable `.select()` shape works as long as it
 * carries `id`); this helper layers on the derived status so downstream
 * consumers see the same `Pipeline` shape they did before the column
 * disappeared.
 *
 * Two patterns:
 *
 *   const { data: row } = await sb.from("pipelines").select("*").eq("id", id).maybeSingle();
 *   const pipeline = await hydratePipelineStatus(sb, row);
 *
 *   const rows = await listPipelinesRaw();
 *   const enriched = await hydratePipelineStatusMany(sb, rows);
 */
export async function hydratePipelineStatus<T extends { id: string }>(
  supabase: AdminLikeClient,
  row: T,
): Promise<T & { status: PipelineStatus }> {
  const status = await getDerivedStatus(supabase, row.id);
  // The reducer never returns null for a real id (it defaults to
  // 'configuration' for an empty event stream); the fallback is defensive.
  return { ...row, status: status ?? ("configuration" as PipelineStatus) };
}

/**
 * Batch variant: enrich each row with `status` from the reducer. One RPC
 * call per row (the reducer is unindexed across pipelines so a single-shot
 * read is the simplest correct approach; the dashboard list page renders
 * at most ~50 rows per page so the round-trip cost is bounded).
 */
export async function hydratePipelineStatusMany<T extends { id: string }>(
  supabase: AdminLikeClient,
  rows: readonly T[],
): Promise<Array<T & { status: PipelineStatus }>> {
  const out: Array<T & { status: PipelineStatus }> = [];
  for (const row of rows) {
    out.push(await hydratePipelineStatus(supabase, row));
  }
  return out;
}
