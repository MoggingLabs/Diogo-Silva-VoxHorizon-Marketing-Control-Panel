/**
 * Silent-failure PR-2a: typed shapes the dashboard surfaces read.
 *
 * Source of truth is `db/migrations/0050_work_item_queue.sql`. These types
 * stay aligned with the generated row types in `lib/supabase/types.gen.ts`
 * (see `work_item`, `work_item_consumers`, `v_pipeline_dispatch_state`).
 *
 * The READ side (this PR, PR-2a) imports these. The enqueue helper + the
 * worker consumer daemon (PR-1) own the WRITE shapes.
 *
 * Logic helpers (`deriveDaemonFreshness`, `WORK_ITEM_KIND_LABEL`) live in
 * `./freshness.ts` so they aren't excluded from coverage by the global
 * `**\/types.ts` rule in `vitest.config.ts`. The two are re-exported here
 * for callers that want a single import.
 */

import type { Database, Json } from "@/lib/supabase/types.gen";

/** The 7 work_item.status values (enum `work_item_status` in 0050). */
export type WorkItemStatus = Database["public"]["Enums"]["work_item_status"];

/** The 13 work_item.kind values (enum `work_item_kind` in 0050). */
export type WorkItemKind = Database["public"]["Enums"]["work_item_kind"];

/**
 * A row from the `work_item` queue table. Matches the generated `Row` type
 * 1:1 but is re-exported here so the components/hooks/routes don't have to
 * reach into `Database["public"]["Tables"]["work_item"]["Row"]` everywhere.
 */
export type WorkItem = Database["public"]["Tables"]["work_item"]["Row"];

/** The 5 work_item_consumers.status values (CHECK constraint in 0050). */
export type DaemonStatus = "starting" | "live" | "degraded" | "stopped" | "down";

/** A row from the `work_item_consumers` presence table. */
export type WorkItemConsumer = Database["public"]["Tables"]["work_item_consumers"]["Row"];

/**
 * Client-side derived freshness of the operator daemon. Maps `(consumer.status,
 * last_seen_at, now())` to a single colour:
 *   - 'live'     -> daemon is heartbeating within the threshold
 *   - 'starting' -> daemon row exists but status='starting' (cold boot)
 *   - 'stale'    -> last_seen_at older than the threshold (badge yellow)
 *   - 'down'     -> consumer.status='down' OR no consumer row exists
 */
export type DaemonFreshness = "live" | "starting" | "stale" | "down";

/**
 * The single-pipeline state envelope read from `v_pipeline_dispatch_state`.
 *
 * Returned by /api/pipelines/[id]/work-state and consumed by both
 * useActiveWorkItem (initial fetch) and the WorkItemPanel (props on SSR).
 *
 * `recent_events` is the last 10 events for the pipeline (newest-first); the
 * jsonb_agg in the view returns them as `Json` so we re-narrow here.
 */
export type PipelineDispatchState = {
  pipelineId: string;
  derivedStatus: Database["public"]["Enums"]["pipeline_status_enum"];
  activeWorkItem: WorkItem | null;
  recentEvents: PipelineEventRow[];
  operatorDaemon: WorkItemConsumer | null;
};

/**
 * One element of `v_pipeline_dispatch_state.recent_events`. Mirrors the
 * generated `pipeline_events` Row; we redeclare here so the timeline preview
 * doesn't need a second import.
 */
export type PipelineEventRow = {
  id: string;
  pipeline_id: string;
  kind: string;
  stage: Database["public"]["Enums"]["pipeline_status_enum"] | null;
  payload: Json | null;
  created_at: string;
  source?: Database["public"]["Enums"]["pipeline_event_source_enum"];
};

// Re-export the helpers from ./freshness.ts so callers can `import { ... }
// from "@/lib/work-queue/types"` without juggling two paths.
export { DAEMON_STALE_THRESHOLD_S, WORK_ITEM_KIND_LABEL, deriveDaemonFreshness } from "./freshness";
