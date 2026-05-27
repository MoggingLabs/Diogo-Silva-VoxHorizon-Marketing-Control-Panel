import "server-only";

import { isOperatorDriven } from "@/lib/operator/dispatch";
import type { PipelineEvent, PipelineStatus } from "@/lib/pipeline/types";
import { createAdminClient } from "@/lib/supabase/admin";
import type { WorkItemStatus } from "@/lib/work-queue/types";

/**
 * Server-side data loader for the Operator Console (E5.3 / #597).
 *
 * The console supervises the operator's live runs, so it lists the ACTIVE
 * (non-terminal, non-archived) operator-driven pipelines newest-activity-first,
 * resolves a friendly client name, and seeds each run's recent narration events
 * so the realtime `OperatorNarration` feed has an instant first paint.
 *
 * "Operator-driven" is read from `pipelines.config_draft.operator_driven`
 * (the kickoff route stamps it) via the shared `isOperatorDriven` predicate —
 * the same gate the launch route uses — so manual pipelines stay off the
 * console.
 */

const TERMINAL: PipelineStatus[] = ["done", "cancelled"];

export type OperatorRun = {
  id: string;
  status: PipelineStatus;
  format_choice: string;
  client_id: string | null;
  clientName: string | null;
  created_at: string;
  updated_at: string | null;
  events: PipelineEvent[];
  /**
   * Silent-failure PR-2a: the current dispatch status (queued/claimed/running
   * for an active row, terminal for the most recent completed row). `null`
   * means no work_item exists for this pipeline yet — rendered as the "Idle"
   * pill in the console.
   */
  dispatchStatus: WorkItemStatus | null;
};

/** How many recent events to seed per run for the narration feed. */
const EVENTS_PER_RUN = 30;

export async function getOperatorRuns(limit = 25): Promise<OperatorRun[]> {
  const supabase = createAdminClient();

  // Active, non-archived runs, newest activity first. Silent-failure PR-4:
  // `pipelines.status` was dropped (migration 0051) -- derived_status now
  // comes from `v_pipeline_dispatch_state`. We over-fetch a little and filter
  // to operator-driven in app code (config_draft is jsonb; a JSON arrow filter
  // is brittle across PostgREST versions, and the active set is small).
  const { data: rows } = await supabase
    .from("pipelines")
    .select("id, format_choice, client_id, config_draft, created_at, updated_at")
    .is("deleted_at", null)
    .order("updated_at", { ascending: false })
    .limit(limit * 2);

  const candidateRows = (rows ?? []).filter((r) => isOperatorDriven(r.config_draft));
  if (candidateRows.length === 0) return [];

  // Fetch the derived statuses for the candidate set in one round-trip, then
  // drop the terminal rows (done / cancelled) so the console only lists
  // ACTIVE runs.
  const candidateIds = candidateRows.map((r) => r.id);
  const { data: dispatchRows } = await supabase
    .from("v_pipeline_dispatch_state")
    .select("pipeline_id, derived_status")
    .in("pipeline_id", candidateIds);
  const statusById = new Map<string, PipelineStatus>();
  for (const dr of dispatchRows ?? []) {
    if (!dr.pipeline_id) continue;
    statusById.set(dr.pipeline_id, (dr.derived_status ?? "configuration") as PipelineStatus);
  }

  const operatorRows = candidateRows
    .map((r) => ({
      ...r,
      status: statusById.get(r.id) ?? ("configuration" as PipelineStatus),
    }))
    .filter((r) => !TERMINAL.includes(r.status))
    .slice(0, limit);

  if (operatorRows.length === 0) return [];

  const ids = operatorRows.map((r) => r.id);

  // Resolve client names in one round-trip.
  const clientIds = Array.from(
    new Set(operatorRows.map((r) => r.client_id).filter((id): id is string => !!id)),
  );
  const clientNames: Record<string, string> = {};
  if (clientIds.length > 0) {
    const { data: clients } = await supabase.from("clients").select("id, name").in("id", clientIds);
    for (const c of clients ?? []) clientNames[c.id] = c.name;
  }

  // Seed recent events for all runs in one query, then bucket by pipeline.
  const { data: events } = await supabase
    .from("pipeline_events")
    .select("id, pipeline_id, kind, stage, payload, created_at")
    .in("pipeline_id", ids)
    .order("created_at", { ascending: false })
    .limit(EVENTS_PER_RUN * operatorRows.length);

  const eventsByPipeline = new Map<string, PipelineEvent[]>();
  for (const ev of events ?? []) {
    const list = eventsByPipeline.get(ev.pipeline_id) ?? [];
    if (list.length < EVENTS_PER_RUN) {
      list.push(ev as unknown as PipelineEvent);
      eventsByPipeline.set(ev.pipeline_id, list);
    }
  }

  // Silent-failure PR-2a: the most-recent work_item per pipeline drives the
  // mini dispatch pill in the console. Prefer an active (queued/claimed/running)
  // row; fall back to the latest terminal row so the pill keeps showing the
  // last outcome until the next dispatch fires.
  const { data: workItems } = await supabase
    .from("work_item")
    .select("pipeline_id, status, created_at")
    .in("pipeline_id", ids)
    .order("created_at", { ascending: false });

  const dispatchByPipeline = new Map<string, WorkItemStatus>();
  const activeStatuses: ReadonlySet<WorkItemStatus> = new Set(["queued", "claimed", "running"]);
  for (const wi of workItems ?? []) {
    if (!wi.pipeline_id) continue;
    if (dispatchByPipeline.has(wi.pipeline_id)) {
      // We've already taken the newest row for this pipeline; if that row
      // is non-active, we still want to upgrade to an active row if one
      // exists earlier in the (newest-first) list. Active wins.
      const prev = dispatchByPipeline.get(wi.pipeline_id)!;
      if (!activeStatuses.has(prev) && activeStatuses.has(wi.status as WorkItemStatus)) {
        dispatchByPipeline.set(wi.pipeline_id, wi.status as WorkItemStatus);
      }
      continue;
    }
    dispatchByPipeline.set(wi.pipeline_id, wi.status as WorkItemStatus);
  }

  return operatorRows.map((r) => ({
    id: r.id,
    status: r.status,
    format_choice: r.format_choice,
    client_id: r.client_id,
    clientName: r.client_id ? (clientNames[r.client_id] ?? null) : null,
    created_at: r.created_at,
    updated_at: r.updated_at,
    // Events came back newest-first; the narration view expects chronological
    // and re-sorts internally, so hand it oldest-first for stability.
    events: (eventsByPipeline.get(r.id) ?? []).slice().reverse(),
    dispatchStatus: dispatchByPipeline.get(r.id) ?? null,
  }));
}
