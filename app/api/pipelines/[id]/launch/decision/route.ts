import { NextResponse, type NextRequest } from "next/server";

import { LaunchDecisionInput } from "@/lib/pipeline/decision-schemas";
import { type PipelineEventInsert, type PipelineUpdate } from "@/lib/pipeline/schemas";
import { getReviewBundle } from "@/lib/review/fetch";
import { buildGridRows, launchPreconditions, launchReady } from "@/lib/review/grid";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/types.gen";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * POST /api/pipelines/:id/launch/decision
 *
 * The HARD launch gate (#361, P4.6). The manager approves the PAUSED-first
 * launch once the preconditions hold (spec-pass ∧ compliance-clear ∧ ≥3
 * approved copy/creative). The route:
 *   - guards the pipeline is in `launch_handoff` (409 otherwise),
 *   - **re-derives the preconditions server-side** from the live per-creative
 *     data (never trusts the client) and refuses (422) if they aren't met —
 *     the compliance/launch gates never auto-pass,
 *   - on approve: records the decision, advances to `monitor`, and forwards to
 *     the worker launch endpoint (PAUSED-first; failures are swallowed so a
 *     worker outage doesn't undo the committed gate),
 *   - on reject: stays in `launch_handoff` (the manager can re-evaluate); the
 *     rejection is recorded on the timeline.
 *
 * NOTE: the Meta *activate* step is a separate, approval-gated operator action
 * (the approvals plugin). This route only opens the launch handoff.
 */
export async function POST(req: NextRequest, ctx: RouteContext) {
  const { id } = await ctx.params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = LaunchDecisionInput.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation_failed", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const { decision, notes } = parsed.data;

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
  if (pipeline.status !== "launch_handoff") {
    return NextResponse.json(
      { error: "invalid_state", current: pipeline.status, expected: "launch_handoff" },
      { status: 409 },
    );
  }

  const now = new Date().toISOString();

  if (decision === "rejected") {
    const event: PipelineEventInsert = {
      pipeline_id: id,
      kind: "launch_rejected",
      stage: "launch_handoff",
      payload: { notes: notes ?? null } as Json,
    };
    const { error: evErr } = await supabase.from("pipeline_events").insert(event);
    if (evErr) {
      console.warn(`[pipelines.launch.decision] event insert failed: ${evErr.message}`);
    }
    return NextResponse.json({ pipeline, decision });
  }

  // Approve: re-derive the preconditions from the live per-creative data. The
  // hard gate NEVER trusts the client and NEVER auto-passes.
  const bundle = await getReviewBundle(id);
  const rows = buildGridRows(bundle.creatives, bundle.states);
  const preconditions = launchPreconditions(rows, bundle.copyVariants);
  if (!launchReady(preconditions)) {
    return NextResponse.json(
      {
        error: "launch_blocked",
        reason: "launch preconditions not met (spec-pass + compliance-clear + >=3 approved copy)",
        preconditions,
      },
      { status: 422 },
    );
  }

  const advancedAt =
    pipeline.advanced_at &&
    typeof pipeline.advanced_at === "object" &&
    !Array.isArray(pipeline.advanced_at)
      ? (pipeline.advanced_at as Record<string, string>)
      : {};
  const update: PipelineUpdate = {
    status: "monitor",
    advanced_at: { ...advancedAt, monitor: now } as unknown as Json,
  };
  const { data: updated, error: updateErr } = await supabase
    .from("pipelines")
    .update(update)
    .eq("id", id)
    .eq("status", "launch_handoff")
    .select()
    .single();
  if (updateErr || !updated) {
    return NextResponse.json(
      { error: updateErr?.message ?? "launch advance failed" },
      { status: 500 },
    );
  }

  const event: PipelineEventInsert = {
    pipeline_id: id,
    kind: "stage_advanced",
    stage: "monitor",
    payload: { decision, paused_first: true } as Json,
  };
  const { error: evErr } = await supabase.from("pipeline_events").insert(event);
  if (evErr) {
    console.warn(`[pipelines.launch.decision] event insert failed: ${evErr.message}`);
  }

  // Forward to the worker launch endpoint (PAUSED-first). Best-effort: the gate
  // has committed and must not be undone by a worker outage.
  void fireWorkerLaunch(id).catch((e) => {
    console.warn(`[pipelines.launch.decision] worker launch kick failed for ${id}: ${String(e)}`);
  });

  return NextResponse.json({ pipeline: updated, decision, preconditions });
}

/**
 * Fire-and-forget POST to the worker's launch endpoint. Mirrors the advance
 * route's worker helpers: skip when WORKER_URL / WORKER_SHARED_SECRET unset,
 * swallow a 404, throw on any other non-2xx so the caller's `.catch()` logs it.
 */
async function fireWorkerLaunch(pipelineId: string): Promise<void> {
  const base = process.env.WORKER_URL?.replace(/\/$/, "");
  const secret = process.env.WORKER_SHARED_SECRET;
  if (!base || !secret) return;
  const res = await fetch(`${base}/work/pipeline/launch`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secret}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ pipeline_id: pipelineId }),
    cache: "no-store",
  });
  if (!res.ok && res.status !== 404) {
    const text = await res.text().catch(() => "");
    throw new Error(`worker /work/pipeline/launch -> ${res.status}: ${text.slice(0, 200)}`);
  }
}
