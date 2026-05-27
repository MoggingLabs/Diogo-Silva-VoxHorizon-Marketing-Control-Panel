import { NextResponse, type NextRequest } from "next/server";

import { isOperatorDriven, operatorInstruction } from "@/lib/operator/dispatch";
import { getDerivedStatus } from "@/lib/pipeline/derived-status";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/lib/supabase/types.gen";
import { enqueueWorkItem } from "@/lib/work-queue/enqueue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * POST /api/pipelines/:id/redispatch
 *
 * Manual recovery action: re-enqueue the latest failed / timed-out operator
 * dispatch for a pipeline so the operator daemon picks it up again. The retry
 * trail chains via `parent_work_item_id` so the dashboard can render the full
 * dispatch history -- the dead-letter view in the audit page reads the chain.
 *
 * This is the silent-failure foundational redesign's recovery path: a panel
 * surface that shows a `failed` work_item also surfaces "Redispatch" so the
 * manager can recover without restarting the pipeline. The redispatch enqueues
 * a fresh row (with `parent_work_item_id` set to the failed row) and the
 * auto-emit trigger writes the pipeline event the timeline reads. The legacy
 * fire-and-forget paths are NOT touched by this route -- this is purely the
 * queue-driven recovery surface.
 *
 * Status codes:
 *   - 200: redispatch enqueued; body `{ work_item_id, duplicate }`
 *   - 404: pipeline not found
 *   - 409 `{error:'invalid_state', from:status}`: pipeline is terminal
 *     (`cancelled` / `done`); nothing to redispatch.
 *   - 409 `{error:'not_operator_driven'}`: pipeline is regular (not
 *     operator-driven), so a redispatch makes no sense -- the deterministic
 *     producers do not use the operator dispatch path.
 *   - 409 `{error:'no_failed_dispatch'}`: the pipeline has no failed /
 *     timed-out operator_dispatch work_item to retry.
 *   - 500: a DB read / enqueue error other than a worker fault.
 *   - 502: worker / enqueue fault -- the row could not be queued (treat as a
 *     bad-gateway upstream signal so the panel renders the "worker down" state
 *     rather than a flat 500).
 */
export async function POST(_req: NextRequest, ctx: RouteContext) {
  const { id } = await ctx.params;
  const supabase = createAdminClient();

  // 1. Load the pipeline. We need `config_draft` for the operator-driven
  //    check; `status` was dropped in migration 0051 so we derive it from
  //    the reducer.
  const { data: pipeline, error: readErr } = await supabase
    .from("pipelines")
    .select("id, config_draft")
    .eq("id", id)
    .maybeSingle();
  if (readErr) {
    return NextResponse.json({ error: readErr.message }, { status: 500 });
  }
  if (!pipeline) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const derivedStatus = await getDerivedStatus(supabase, pipeline.id);

  // 2. Terminal pipelines have nothing to redispatch -- the operator daemon
  //    propagates pipeline_cancelled to every open work_item, so a cancelled
  //    pipeline's queue is empty by definition.
  if (derivedStatus === "cancelled" || derivedStatus === "done") {
    return NextResponse.json({ error: "invalid_state", from: derivedStatus }, { status: 409 });
  }

  // 3. Redispatch is only meaningful for operator-driven pipelines: the
  //    deterministic producers do not enqueue operator_dispatch work_items
  //    (their kinds are worker_ideation / worker_generation), so there is no
  //    failed row of the kind we'd retry. Regular pipelines: 409.
  if (!isOperatorDriven(pipeline.config_draft)) {
    return NextResponse.json({ error: "not_operator_driven" }, { status: 409 });
  }

  // 4. Look up the latest failed / timed-out operator_dispatch work_item for
  //    this pipeline. We chain the new row to it via parent_work_item_id so
  //    the retry trail is visible in the panel + audit view.
  const { data: latestFailed, error: lookupErr } = await supabase
    .from("work_item")
    .select("id, payload")
    .eq("pipeline_id", pipeline.id)
    .eq("kind", "operator_dispatch")
    .in("status", ["failed", "timed_out"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (lookupErr) {
    return NextResponse.json({ error: lookupErr.message }, { status: 500 });
  }
  if (!latestFailed) {
    return NextResponse.json({ error: "no_failed_dispatch" }, { status: 409 });
  }

  // 5. Derive the payload + stage from the failed row when possible (preserves
  //    the operator's exact instruction). If the stored payload is missing
  //    or malformed we fall back to a freshly-rebuilt instruction keyed to
  //    the pipeline's current derived status.
  type FailedRow = {
    id: string;
    payload: Database["public"]["Tables"]["work_item"]["Row"]["payload"];
  };
  const failed = latestFailed as unknown as FailedRow;
  const payload = readWorkItemPayload(failed.payload);
  const stage =
    (typeof payload.stage === "string" && payload.stage.length > 0
      ? payload.stage
      : derivedStatus) ?? "configuration";

  const instruction =
    typeof payload.instruction === "string" && payload.instruction.length > 0
      ? payload.instruction
      : operatorInstruction(stage as Parameters<typeof operatorInstruction>[0], pipeline.id);

  // 6. Enqueue the retry. parent_work_item_id chains it to the failed row;
  //    idempotencyKey includes the failed row's id so two redispatch clicks
  //    on the same failed row are deduped to one queued row.
  try {
    const result = await enqueueWorkItem({
      kind: "operator_dispatch",
      pipelineId: pipeline.id,
      payload: { instruction, stage },
      idempotencyKey: `op-disp:${pipeline.id}:${stage}:redispatch:${failed.id}`,
      createdBy: "api/pipelines/redispatch",
      parentWorkItemId: failed.id,
    });
    return NextResponse.json({ work_item_id: result.id, duplicate: result.duplicate });
  } catch (e) {
    return NextResponse.json({ error: `work_item enqueue failed: ${String(e)}` }, { status: 502 });
  }
}

/**
 * Narrow the stored payload (the `Json` column) to the shape we expect from a
 * dispatcher (instruction string + stage). Returns an empty record on any
 * unexpected shape so the caller can fall back cleanly without throwing.
 */
function readWorkItemPayload(value: unknown): { instruction?: string; stage?: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const obj = value as Record<string, unknown>;
  const out: { instruction?: string; stage?: string } = {};
  if (typeof obj.instruction === "string") out.instruction = obj.instruction;
  if (typeof obj.stage === "string") out.stage = obj.stage;
  return out;
}
