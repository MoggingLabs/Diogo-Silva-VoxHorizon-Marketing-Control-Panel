import { NextResponse, type NextRequest } from "next/server";

import { MonitorDecisionInput } from "@/lib/pipeline/decision-schemas";
import { type PipelineEventInsert, type PipelineUpdate } from "@/lib/pipeline/schemas";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/types.gen";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * POST /api/pipelines/:id/monitor/decision
 *
 * The monitor stage kill/scale verdict (#362, P4.7).
 *   - `kill`  → records the kill, advances to `done`, forwards to the worker so
 *     it can pause/archive the Meta entities (PAUSED, never stop-live-spend).
 *   - `scale` → records the scale intent, advances to `done`.
 *
 * The monitor loop spawns a NEW pipeline rather than looping back, so both
 * verdicts are terminal for this run (status → done). Status guard: 409 unless
 * the pipeline is in `monitor`.
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
  const { decision, campaign_id, notes } = parsed.data;

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
  if (pipeline.status !== "monitor") {
    return NextResponse.json(
      { error: "invalid_state", current: pipeline.status, expected: "monitor" },
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
  const update: PipelineUpdate = {
    status: "done",
    advanced_at: { ...advancedAt, done: now } as unknown as Json,
  };
  const { data: updated, error: updateErr } = await supabase
    .from("pipelines")
    .update(update)
    .eq("id", id)
    .eq("status", "monitor")
    .select()
    .single();
  if (updateErr || !updated) {
    return NextResponse.json(
      { error: updateErr?.message ?? "monitor decision update failed" },
      { status: 500 },
    );
  }

  const event: PipelineEventInsert = {
    pipeline_id: id,
    kind: "monitor_decision",
    stage: "done",
    payload: { decision, campaign_id: campaign_id ?? null, notes: notes ?? null } as Json,
  };
  const { error: evErr } = await supabase.from("pipeline_events").insert(event);
  if (evErr) {
    console.warn(`[pipelines.monitor.decision] event insert failed: ${evErr.message}`);
  }

  // Forward the verdict to the worker (kill → pause/archive; scale → budget
  // bump). Best-effort: the run already terminated, so a worker outage must
  // not undo it.
  void fireWorkerMonitor(id, decision, campaign_id).catch((e) => {
    console.warn(`[pipelines.monitor.decision] worker monitor kick failed for ${id}: ${String(e)}`);
  });

  return NextResponse.json({ pipeline: updated, decision });
}

/**
 * Fire-and-forget POST to the worker's monitor endpoint. Same contract as the
 * other worker helpers: skip when unconfigured, swallow 404, throw otherwise.
 */
async function fireWorkerMonitor(
  pipelineId: string,
  decision: "kill" | "scale",
  campaignId?: string,
): Promise<void> {
  const base = process.env.WORKER_URL?.replace(/\/$/, "");
  const secret = process.env.WORKER_SHARED_SECRET;
  if (!base || !secret) return;
  const res = await fetch(`${base}/work/pipeline/monitor`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secret}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ pipeline_id: pipelineId, decision, campaign_id: campaignId }),
    cache: "no-store",
  });
  if (!res.ok && res.status !== 404) {
    const text = await res.text().catch(() => "");
    throw new Error(`worker /work/pipeline/monitor -> ${res.status}: ${text.slice(0, 200)}`);
  }
}
