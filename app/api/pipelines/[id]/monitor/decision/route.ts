import { NextResponse, type NextRequest } from "next/server";

import { operatorInstruction } from "@/lib/operator/dispatch";
import { getDerivedStatus } from "@/lib/pipeline/derived-status";
import { MonitorDecisionInput } from "@/lib/pipeline/decision-schemas";
import { type PipelineEventInsert, type PipelineUpdate } from "@/lib/pipeline/schemas";
import type { PipelineStatus } from "@/lib/pipeline/types";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/types.gen";
import { enqueueWorkItem } from "@/lib/work-queue/enqueue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * POST /api/pipelines/:id/monitor/decision
 *
 * The monitor stage kill/scale verdict (#362, P4.7). Both verdicts advance the
 * run to `done` AND dispatch the operator to EXECUTE the approved action on
 * Meta (Meta is operator-held MCP; the worker has no Meta credentials, mirror
 * of the launch pattern):
 *   - `kill`  -> enqueue `operator_dispatch(monitor_action)` so the operator
 *     pauses the live campaign on Meta (`ads_update_entity` -> status PAUSED).
 *   - `scale` -> enqueue `operator_dispatch(monitor_action)` so the operator
 *     raises the winning campaign's daily budget on Meta (`ads_update_entity`
 *     -> daily_budget = `target_budget`).
 *
 * The operator records the executed outcome via the worker
 * `/work/pipeline/tools/monitor_action_result` recorder (who/what/when + the
 * new budget or the pause). This replaces the prior no-op: the route used to
 * enqueue a `worker_monitor` work_item whose handler only logged + acked, so a
 * "kill" never paused the campaign and a "scale" never changed spend.
 *
 * Behavior change (flagged in the PR): the previous scale->spawn-next-brief
 * side effect is REMOVED. Spinning up another pipeline is a separate kickoff
 * action, not a "scale this campaign" action.
 *
 * Both verdicts are terminal for this run (status -> done). Status guard: 409
 * unless the pipeline is in `monitor`.
 */
export async function POST(req: NextRequest, ctx: RouteContext) {
  const { id } = await ctx.params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = MonitorDecisionInput.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation_failed", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const { decision, campaign_id, notes, target_budget } = parsed.data;

  const supabase = createAdminClient();

  const { data: pipeline, error: readErr } = await supabase
    .from("pipelines")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (readErr) {
    return NextResponse.json({ error: readErr.message }, { status: 500 });
  }
  if (!pipeline) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  // Silent-failure PR-4: read derived status from the reducer
  // (`pipelines.status` was dropped in 0051).
  const derivedStatus = await getDerivedStatus(supabase, pipeline.id);
  if (derivedStatus !== "monitor") {
    return NextResponse.json(
      { error: "invalid_state", current: derivedStatus, expected: "monitor" },
      { status: 409 },
    );
  }

  const now = new Date().toISOString();
  const advancedAt =
    pipeline.advanced_at &&
    typeof pipeline.advanced_at === "object" &&
    !Array.isArray(pipeline.advanced_at)
      ? (pipeline.advanced_at as Record<string, string>)
      : {};
  // Silent-failure PR-4: `pipelines.status` was dropped (migration 0051).
  // The stage_advanced event below is the canonical status write.
  const update: PipelineUpdate = {
    advanced_at: { ...advancedAt, done: now } as unknown as Json,
  };
  const { data: updated, error: updateErr } = await supabase
    .from("pipelines")
    .update(update)
    .eq("id", id)
    .select()
    .single();
  if (updateErr || !updated) {
    return NextResponse.json(
      { error: updateErr?.message ?? "monitor decision update failed" },
      { status: 500 },
    );
  }

  // Emit the canonical stage_advanced event (reducer's load-bearing input)
  // AND the monitor_decision audit event. Both are strict (no swallow).
  const stageEvent: PipelineEventInsert = {
    pipeline_id: id,
    kind: "stage_advanced",
    stage: "done",
    payload: { from: "monitor", decision } as Json,
  };
  const { error: stageEvErr } = await supabase.from("pipeline_events").insert(stageEvent);
  if (stageEvErr) {
    return NextResponse.json(
      { error: `stage_advanced event insert failed: ${stageEvErr.message}` },
      { status: 500 },
    );
  }

  const event: PipelineEventInsert = {
    pipeline_id: id,
    kind: "monitor_decision",
    stage: "done",
    payload: {
      decision,
      campaign_id: campaign_id ?? null,
      notes: notes ?? null,
      target_budget: target_budget ?? null,
    } as Json,
  };
  const { error: evErr } = await supabase.from("pipeline_events").insert(event);
  if (evErr) {
    return NextResponse.json(
      { error: `monitor_decision event insert failed: ${evErr.message}` },
      { status: 500 },
    );
  }

  // Execute the approved verdict on Meta via the OPERATOR (Meta is
  // operator-held MCP; the worker has no Meta credentials -- mirror of launch).
  // Enqueue an `operator_dispatch(monitor_action)` carrying the verdict; the
  // daemon claims it and the operator looks up the campaign's live meta_id from
  // `ad_entity` (kind='campaign'), calls the Meta MCP `ads_update_entity`
  // (kill -> status PAUSED; scale -> raise daily_budget), then records the
  // outcome via the worker `monitor_action_result` recorder.
  //
  // FIX (monitor connector): the route used to enqueue a no-op `worker_monitor`
  // row whose handler only logged + acked, so the verdict never reached Meta.
  // The enqueue is the SOLE producer of the executed side effect; a failed
  // enqueue is a 5xx (mirror of the post-gen dispatch routes) -- the action
  // must never silently go missing.
  const brief =
    decision === "scale" && typeof target_budget === "number"
      ? `Verdict: scale. Campaign: ${campaign_id ?? "the winning campaign"}. Target daily_budget: ${target_budget}.`
      : `Verdict: ${decision}. Campaign: ${campaign_id ?? "the winning campaign"}.`;
  try {
    await enqueueWorkItem({
      kind: "operator_dispatch",
      pipelineId: id,
      payload: {
        instruction: operatorInstruction("monitor_action", id, brief),
        // `stage` is folded into the auto-emit trigger's stage cast; keep it a
        // valid pipeline_status_enum value (`monitor`) and carry the action +
        // verdict separately so the trigger does not null the stage column.
        stage: "monitor",
        action: "monitor_action",
        decision,
        campaign_id: campaign_id ?? null,
        notes: notes ?? null,
        ...(typeof target_budget === "number" ? { target_budget } : {}),
      },
      idempotencyKey: `op-disp:${id}:monitor_action:${decision}`,
      createdBy: "api/pipelines/monitor/decision",
    });
  } catch (e) {
    return NextResponse.json(
      { error: `monitor_action dispatch enqueue failed: ${String(e)}` },
      { status: 500 },
    );
  }

  return NextResponse.json({
    pipeline: { ...updated, status: "done" as PipelineStatus },
    decision,
  });
}
