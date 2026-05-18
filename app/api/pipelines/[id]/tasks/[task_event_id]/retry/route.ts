import { NextResponse, type NextRequest } from "next/server";

import { HermesError, kanbanRetry } from "@/lib/hermes/client";
import type { PipelineEventInsert } from "@/lib/pipeline/schemas";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/types.gen";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ id: string; task_event_id: string }>;
};

type SupabaseClient = ReturnType<typeof createAdminClient>;

/**
 * POST /api/pipelines/:id/tasks/:task_event_id/retry
 *
 * Per-task retry for the Generation stage. Maps the
 * `pipeline_events.id` (an error row the dashboard surfaced as a Retry
 * button) to its `hermes_tasks.kanban_task_id` and asks the worker's
 * `/work/hermes/kanban/{task_id}/retry` endpoint to reclaim + unblock
 * the task. The bridge mirrors the new status back into `hermes_tasks`
 * and the dashboard picks it up via realtime — no extra
 * `pipeline_events` row is needed beyond the tracking entry we write
 * locally.
 *
 * Mapping strategy: the worker's kanban service mirrors each task into
 * `hermes_tasks` with the originating `pipeline_id` and a `context`
 * jsonb. We don't store `kanban_task_id` on the `pipeline_events` row
 * directly today, so we look up `hermes_tasks` by
 * `(pipeline_id, kanban_task_id)` using a value the source event's
 * payload carries (the `task_id` field — set by the kanban mirror when
 * it emits the synthetic `task_error` event).
 *
 * Returns 202 with `{ retry_task_id, kanban_task_id }` so the client
 * can correlate the optimistic UI row with the realtime stream.
 */
export async function POST(_req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  const { id: pipelineId, task_event_id: taskEventId } = await ctx.params;
  const supabase = createAdminClient();

  // 1. Load the source event and validate.
  const { data: source, error: srcErr } = await supabase
    .from("pipeline_events")
    .select("*")
    .eq("id", taskEventId)
    .eq("pipeline_id", pipelineId)
    .maybeSingle();
  if (srcErr) {
    return NextResponse.json({ error: srcErr.message }, { status: 500 });
  }
  if (!source) {
    return NextResponse.json({ error: "task event not found" }, { status: 404 });
  }
  if (source.kind !== "task_error") {
    return NextResponse.json(
      {
        error: "validation_failed",
        reason: `retry requires a task_error event, got kind=${source.kind}`,
      },
      { status: 422 },
    );
  }
  if (source.stage !== "generation") {
    return NextResponse.json(
      {
        error: "validation_failed",
        reason: "retry is only supported for generation-stage tasks",
      },
      { status: 422 },
    );
  }

  // 2. Resolve the kanban_task_id this event refers to. Two routes:
  //      a) the payload may carry it inline (`task_id` set by the
  //         hermes-kanban mirror when it emitted the synthetic event);
  //      b) fall back to a hermes_tasks lookup by pipeline_id (newest
  //         active mirror row) — this is the migration path for older
  //         pipelines whose error events predate the inline field.
  const kanbanTaskId = await resolveKanbanTaskId(supabase, source, pipelineId);
  if (!kanbanTaskId) {
    return NextResponse.json(
      {
        error: "validation_failed",
        reason:
          "could not resolve kanban_task_id for retry — payload missing task_id and no matching hermes_tasks row",
      },
      { status: 422 },
    );
  }

  // 3. Emit a `task_queued` row immediately so the UI gets a new
  //    lifecycle to render even before the worker confirms.
  const queuedInsert: PipelineEventInsert = {
    pipeline_id: pipelineId,
    kind: "task_queued",
    stage: "generation",
    payload: {
      retry_of: taskEventId,
      kanban_task_id: kanbanTaskId,
    } as Json,
  };
  const { data: queuedRow, error: queuedErr } = await supabase
    .from("pipeline_events")
    .insert(queuedInsert)
    .select("id")
    .single();
  if (queuedErr || !queuedRow) {
    return NextResponse.json(
      { error: queuedErr?.message ?? "failed to queue retry" },
      { status: 500 },
    );
  }

  // 4. Kick the hermes-kanban retry. We await so the response shape
  //    can carry the bridge's result. A worker outage shouldn't
  //    silently leave the kanban row stale — surface the 502 to the
  //    client.
  try {
    await kanbanRetry(kanbanTaskId);
  } catch (err) {
    if (err instanceof HermesError) {
      return NextResponse.json(
        {
          error: "worker_error",
          status: err.status,
          detail: err.message,
          retry_task_id: queuedRow.id,
          kanban_task_id: kanbanTaskId,
        },
        { status: 502 },
      );
    }
    return NextResponse.json(
      {
        error: "worker_unreachable",
        detail: String(err),
        retry_task_id: queuedRow.id,
        kanban_task_id: kanbanTaskId,
      },
      { status: 502 },
    );
  }

  return NextResponse.json(
    {
      retry_task_id: queuedRow.id,
      source_task_id: taskEventId,
      kanban_task_id: kanbanTaskId,
    },
    { status: 202 },
  );
}

/**
 * Best-effort resolver for the kanban_task_id referenced by a
 * `task_error` event. Returns `null` when no candidate is found —
 * callers surface a 422 in that case.
 *
 * Lookup order:
 *  1. The source event's payload may carry `task_id` (canonical when
 *     emitted by the kanban mirror in HI-3 onward).
 *  2. Otherwise, find the most recent non-terminal `hermes_tasks` row
 *     for this pipeline. This is a fallback for legacy pipelines
 *     whose `task_error` events were emitted by the old generation
 *     worker — they don't carry an inline task_id.
 */
async function resolveKanbanTaskId(
  supabase: SupabaseClient,
  source: { payload: unknown },
  pipelineId: string,
): Promise<string | null> {
  const payload = (source.payload ?? {}) as Record<string, unknown>;
  if (typeof payload.task_id === "string" && payload.task_id.length > 0) {
    return payload.task_id;
  }
  if (typeof payload.kanban_task_id === "string" && payload.kanban_task_id.length > 0) {
    return payload.kanban_task_id;
  }

  try {
    // `hermes_tasks` isn't in the typed schema yet (HI-15 migration);
    // cast through `never` to match the escape hatch the advance route
    // uses for the `gen_video_brief_id_human` RPC.
    const { data, error } = await supabase
      .from("hermes_tasks" as never)
      .select("kanban_task_id")
      .eq("pipeline_id" as never, pipelineId)
      .in("status" as never, ["failed", "blocked", "in_progress", "pending"] as unknown as string[])
      .order("updated_at" as never, { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) {
      console.warn(`[pipelines.retry] hermes_tasks fallback lookup failed: ${error.message}`);
      return null;
    }
    const row = (data ?? null) as { kanban_task_id?: string } | null;
    return row?.kanban_task_id ?? null;
  } catch (e) {
    console.warn(`[pipelines.retry] hermes_tasks fallback lookup threw: ${String(e)}`);
    return null;
  }
}
