import "server-only";

import { isOperatorDriven } from "@/lib/operator/dispatch";
import type { PipelineEvent, PipelineStatus } from "@/lib/pipeline/types";
import { createAdminClient } from "@/lib/supabase/admin";

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
};

/** How many recent events to seed per run for the narration feed. */
const EVENTS_PER_RUN = 30;

export async function getOperatorRuns(limit = 25): Promise<OperatorRun[]> {
  const supabase = createAdminClient();

  // Active, non-archived runs, newest activity first. We over-fetch a little and
  // filter to operator-driven in app code (config_draft is jsonb; a JSON arrow
  // filter is brittle across PostgREST versions, and the active set is small).
  const { data: rows } = await supabase
    .from("pipelines")
    .select("id, status, format_choice, client_id, config_draft, created_at, updated_at")
    .is("deleted_at", null)
    .not("status", "in", `(${TERMINAL.join(",")})`)
    .order("updated_at", { ascending: false })
    .limit(limit * 2);

  const operatorRows = (rows ?? []).filter((r) => isOperatorDriven(r.config_draft)).slice(0, limit);

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

  return operatorRows.map((r) => ({
    id: r.id,
    status: r.status as PipelineStatus,
    format_choice: r.format_choice,
    client_id: r.client_id,
    clientName: r.client_id ? (clientNames[r.client_id] ?? null) : null,
    created_at: r.created_at,
    updated_at: r.updated_at,
    // Events came back newest-first; the narration view expects chronological
    // and re-sorts internally, so hand it oldest-first for stability.
    events: (eventsByPipeline.get(r.id) ?? []).slice().reverse(),
  }));
}
