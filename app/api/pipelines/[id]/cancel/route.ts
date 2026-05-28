import { NextResponse, type NextRequest } from "next/server";

import { HermesError, kanbanCancel } from "@/lib/hermes/client";
import { getDerivedStatus } from "@/lib/pipeline/derived-status";
import type { PipelineEventInsert, PipelineUpdate } from "@/lib/pipeline/schemas";
import type { PipelineStatus } from "@/lib/pipeline/types";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/types.gen";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

type SupabaseClient = ReturnType<typeof createAdminClient>;

/**
 * Pending / running statuses on the `hermes_tasks` mirror. Tasks in any
 * of these states still have a live presence on the kanban side so the
 * cancel route fans out a `POST /work/hermes/kanban/{id}/cancel` to
 * each. Terminal rows (`completed`, `cancelled`, `failed`) are ignored
 * — the bridge would reject the call with a 409.
 */
const ACTIVE_TASK_STATUSES = ["pending", "in_progress", "blocked"] as const;

/**
 * POST /api/pipelines/:id/cancel
 *
 * Operator-triggered cancellation. Flips the pipeline to `status='cancelled'`
 * from any of the non-terminal stages (`configuration`, `ideation`, `review`,
 * `generation`) and emits a `pipeline_events(kind='stage_advanced',
 * stage='cancelled', payload={reason: 'operator_cancel'})` row so the timeline
 * reflects the cancel.
 *
 * Status guard: returns 409 if the pipeline is already `cancelled` or `done`
 * — both are terminal in v1. The `from` field on the error body lets the UI
 * surface "this pipeline was already finished/cancelled".
 *
 * Concurrency: the status assertion is re-applied at write time
 * (`.in('status', [...])`) so a concurrent advance can't race a cancel into a
 * terminal stage.
 *
 * Worker abort: after the DB flip we fan out a `cancel` to every
 * pending/running task on the hermes-kanban bridge. Per-task failures
 * are logged but don't fail the route — the row + event are the
 * primary artifacts and the operator can retry individual cancels from
 * the kanban UI if a transient blip eats one.
 */
export async function POST(_req: NextRequest, ctx: RouteContext) {
  const { id } = await ctx.params;

  const supabase = createAdminClient();
  const { data: pipeline, error: readErr } = await supabase
    .from("pipelines")
    .select("id, advanced_at")
    .eq("id", id)
    .maybeSingle();
  if (readErr) {
    return NextResponse.json({ error: readErr.message }, { status: 500 });
  }
  if (!pipeline) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  // Silent-failure PR-4: read the derived status from the reducer
  // (`pipelines.status` was dropped in 0051).
  const derivedStatus = await getDerivedStatus(supabase, pipeline.id);
  if (derivedStatus === "cancelled" || derivedStatus === "done") {
    return NextResponse.json({ error: "invalid_state", from: derivedStatus }, { status: 409 });
  }

  const previousStatus = derivedStatus;
  const now = new Date().toISOString();

  // Stamp `advanced_at.cancelled` without clobbering earlier stage marks.
  const advancedAt =
    pipeline.advanced_at &&
    typeof pipeline.advanced_at === "object" &&
    !Array.isArray(pipeline.advanced_at)
      ? (pipeline.advanced_at as Record<string, string>)
      : {};
  const nextAdvancedAt = { ...advancedAt, cancelled: now };

  // Silent-failure PR-4: `pipelines.status` was dropped (migration 0051).
  // The `pipeline_cancelled` event below is the canonical status write -- it
  // fires the cancel-propagate trigger from migration 0050 (every open
  // work_item for the pipeline is cancelled in the same transaction) AND
  // drives the reducer's terminal-escape branch. The legacy `.in("status",
  // [...])` CAS guard was removed; the derived-status pre-check is the race
  // guard now (a concurrent cancel idempotently re-emits the event).
  const update: PipelineUpdate = {
    advanced_at: nextAdvancedAt as unknown as Json,
  };
  const { data: updated, error: updateErr } = await supabase
    .from("pipelines")
    .update(update)
    .eq("id", pipeline.id)
    .select()
    .single();
  if (updateErr || !updated) {
    return NextResponse.json(
      { error: updateErr?.message ?? "cancel update failed" },
      { status: 500 },
    );
  }

  // Emit the canonical cancel event. Load-bearing input to the
  // cancel-propagate trigger AND the reducer; no longer swallowed.
  const event: PipelineEventInsert = {
    pipeline_id: pipeline.id,
    kind: "pipeline_cancelled",
    stage: "cancelled",
    payload: {
      reason: "operator_cancel",
      previous_status: previousStatus,
    } as Json,
  };
  const { error: evErr } = await supabase.from("pipeline_events").insert(event);
  if (evErr) {
    return NextResponse.json(
      { error: `pipeline_cancelled event insert failed: ${evErr.message}` },
      { status: 500 },
    );
  }

  // Fan out kanban cancels for every still-active task on this pipeline.
  await cancelActiveKanbanTasks(supabase, pipeline.id);

  return NextResponse.json({
    pipeline: { ...updated, status: "cancelled" as PipelineStatus },
  });
}

/**
 * Look up every pending/running `hermes_tasks` row for this pipeline
 * and call `POST /work/hermes/kanban/{task_id}/cancel` for each. The
 * table isn't in the auto-generated types yet (the migration ships
 * with HI-15), so we cast through `never` for the query — the schema
 * exists at runtime and the column shape (`kanban_task_id text`,
 * `status text`) is fixed by `db/migrations/0008_hermes_integration.sql`.
 *
 * Failures are logged and swallowed so a partial outage doesn't fail
 * the surrounding cancel.
 */
async function cancelActiveKanbanTasks(
  supabase: SupabaseClient,
  pipelineId: string,
): Promise<void> {
  let tasks: Array<{ kanban_task_id: string; status: string }> = [];
  try {
    const { data, error } = await supabase
      // The hermes_tasks table is created by the HI-15 migration; the
      // typed schema hasn't been regenerated yet, so we deliberately
      // bypass the generic. Casting through `never` matches the same
      // escape hatch the advance route uses for the
      // `gen_video_brief_id_human` RPC.
      .from("hermes_tasks" as never)
      .select("kanban_task_id, status")
      .eq("pipeline_id" as never, pipelineId)
      .in("status" as never, ACTIVE_TASK_STATUSES as unknown as string[]);
    if (error) {
      console.warn(`[pipelines.cancel] hermes_tasks lookup failed: ${error.message}`);
      return;
    }
    tasks = (data ?? []) as unknown as Array<{ kanban_task_id: string; status: string }>;
  } catch (e) {
    console.warn(`[pipelines.cancel] hermes_tasks lookup threw: ${String(e)}`);
    return;
  }

  if (tasks.length === 0) return;

  await Promise.all(
    tasks.map(async (t) => {
      try {
        await kanbanCancel(t.kanban_task_id);
      } catch (err) {
        if (err instanceof HermesError) {
          console.warn(
            `[pipelines.cancel] kanban cancel ${t.kanban_task_id} -> ${err.status ?? "no-status"}: ${err.message}`,
          );
        } else {
          console.warn(
            `[pipelines.cancel] kanban cancel ${t.kanban_task_id} threw: ${String(err)}`,
          );
        }
      }
    }),
  );
}
