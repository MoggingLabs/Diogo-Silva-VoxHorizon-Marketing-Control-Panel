import { NextResponse, type NextRequest } from "next/server";

import { createAdminClient } from "@/lib/supabase/admin";
import type {
  PipelineDispatchState,
  PipelineEventRow,
  WorkItem,
  WorkItemConsumer,
} from "@/lib/work-queue/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * GET /api/pipelines/:id/work-state
 *
 * Silent-failure PR-2a: the canonical "what is the dispatcher doing right now?"
 * read for one pipeline. Reads ONE row from `v_pipeline_dispatch_state`
 * (migration 0050), which the DB has already pre-computed:
 *
 *   - `derived_status`     — what `compute_pipeline_status` says (event-sourced)
 *   - `active_work_item`   — the most-recent queued/claimed/running work_item
 *   - `recent_events`      — the last 10 pipeline_events (newest-first)
 *   - `operator_daemon`    — the most-recent work_item_consumers row for
 *                            `kind='operator_dispatch'`
 *
 * The view does the join + ordering server-side so the panel renders in ONE
 * round trip. Service-role client (RLS bypass) — the dashboard reads via the
 * Caddy-edge session and the admin client keeps the surface bearer-free.
 *
 * Returns 404 when the pipeline row is missing OR archived (deleted_at is set):
 * an archived run shouldn't drive the live dispatch panel.
 *
 * Response shape mirrors `PipelineDispatchState` so the hook + the component
 * can both type-narrow off the same interface.
 */
export async function GET(_req: NextRequest, ctx: RouteContext) {
  const { id } = await ctx.params;
  const supabase = createAdminClient();

  // The view does NOT filter out archived pipelines (it joins `pipelines`
  // wholesale), so we do that check explicitly so the panel never surfaces
  // dispatch state for a soft-archived run.
  const archived = await supabase
    .from("pipelines")
    .select("id, deleted_at")
    .eq("id", id)
    .maybeSingle();
  if (archived.error) {
    return NextResponse.json({ error: archived.error.message }, { status: 500 });
  }
  if (!archived.data || archived.data.deleted_at) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const { data, error } = await supabase
    .from("v_pipeline_dispatch_state")
    .select("pipeline_id, derived_status, active_work_item, recent_events, operator_daemon")
    .eq("pipeline_id", id)
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!data) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  // The view's columns come back as `Json | null` because PostgREST can't
  // narrow the to_jsonb() result. Narrow here so the hook/component get a
  // typed shape, and keep the runtime checks defensive (the view's contract
  // is enforced by 0050, but a future schema change shouldn't silently corrupt
  // the panel — return nulls instead of throwing).
  const response: PipelineDispatchState = {
    pipelineId: id,
    derivedStatus: data.derived_status ?? "configuration",
    activeWorkItem: (data.active_work_item as WorkItem | null) ?? null,
    recentEvents: Array.isArray(data.recent_events)
      ? (data.recent_events as PipelineEventRow[])
      : [],
    operatorDaemon: (data.operator_daemon as WorkItemConsumer | null) ?? null,
  };

  return NextResponse.json(response);
}
