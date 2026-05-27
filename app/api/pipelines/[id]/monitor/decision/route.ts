import { NextResponse, type NextRequest } from "next/server";

import { getDerivedStatus } from "@/lib/pipeline/derived-status";
import { MonitorDecisionInput } from "@/lib/pipeline/decision-schemas";
import {
  type PipelineEventInsert,
  type PipelineInsert,
  type PipelineUpdate,
} from "@/lib/pipeline/schemas";
import type { PipelineStatus } from "@/lib/pipeline/types";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Database, Json } from "@/lib/supabase/types.gen";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };
type SupabaseClient = ReturnType<typeof createAdminClient>;

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
    payload: { decision, campaign_id: campaign_id ?? null, notes: notes ?? null } as Json,
  };
  const { error: evErr } = await supabase.from("pipeline_events").insert(event);
  if (evErr) {
    return NextResponse.json(
      { error: `monitor_decision event insert failed: ${evErr.message}` },
      { status: 500 },
    );
  }

  // The monitor → next-brief loop (P5.5, #368). A `scale` verdict means this
  // run produced a winner worth expanding, so spawn a NEW `configuration`
  // pipeline seeded from the winning run (same client + format + image-brief
  // payload, tagged `spawned_from`) — the manager picks up a pre-seeded brief
  // instead of starting from scratch. `kill` is terminal: no spawn. The spawn
  // is non-fatal — the parent run already reached `done`; a failed spawn just
  // means the manager starts the next pipeline by hand.
  let spawnedPipelineId: string | null = null;
  let spawnError: string | null = null;
  if (decision === "scale") {
    const spawn = await spawnNextBriefPipeline(supabase, pipeline);
    if (spawn.ok) {
      spawnedPipelineId = spawn.pipelineId;
    } else {
      spawnError = spawn.message;
      console.warn(
        `[pipelines.monitor.decision] next-brief spawn failed for ${id}: ${spawn.message}`,
      );
    }
  }

  // Forward the verdict to the worker (kill → pause/archive; scale → budget
  // bump). Best-effort: the run already terminated, so a worker outage must
  // not undo it.
  void fireWorkerMonitor(id, decision, campaign_id).catch((e) => {
    console.warn(`[pipelines.monitor.decision] worker monitor kick failed for ${id}: ${String(e)}`);
  });

  return NextResponse.json({
    pipeline: { ...updated, status: "done" as PipelineStatus },
    decision,
    ...(spawnedPipelineId ? { spawned_pipeline_id: spawnedPipelineId } : {}),
    ...(spawnError ? { spawn_error: spawnError } : {}),
  });
}

/**
 * Spawn the next-brief pipeline from a `scale` verdict. Seeds a new
 * `configuration` pipeline with the winning run's client + format and (best
 * effort) its image-brief payload, tagged with `spawned_from` for lineage.
 * Returns the new pipeline id, or an error message (non-fatal — see caller).
 */
async function spawnNextBriefPipeline(
  supabase: SupabaseClient,
  parent: Database["public"]["Tables"]["pipelines"]["Row"],
): Promise<{ ok: true; pipelineId: string } | { ok: false; message: string }> {
  // Seed the child's image_payload from the parent's winning brief, if present.
  let imagePayload: Json | null = null;
  if (parent.image_brief_id) {
    const { data: brief } = await supabase
      .from("briefs")
      .select("payload")
      .eq("id", parent.image_brief_id)
      .maybeSingle();
    imagePayload = (brief?.payload as Json | undefined) ?? null;
  }

  const now = new Date().toISOString();
  const configDraft: Record<string, unknown> = {
    spawned_from: parent.id,
    spawn_reason: "scale",
    note:
      `Scaled from pipeline ${parent.id} — winning campaign. Review the seeded ` +
      `brief and adjust the angle / budget before continuing.`,
  };
  if (imagePayload) configDraft.image_payload = imagePayload;

  const insert: PipelineInsert = {
    format_choice: parent.format_choice,
    client_id: parent.client_id,
    config_draft: configDraft as unknown as Json,
    advanced_at: { configuration: now } as unknown as Json,
  };
  const { data: child, error: insertErr } = await supabase
    .from("pipelines")
    .insert(insert)
    .select("id")
    .single();
  if (insertErr || !child) {
    return { ok: false, message: insertErr?.message ?? "spawn insert failed" };
  }

  // Lineage events: close the loop on the parent + record the child's creation.
  const { error: evErr } = await supabase.from("pipeline_events").insert([
    {
      pipeline_id: parent.id,
      kind: "next_brief_spawned",
      stage: "done",
      payload: { child_pipeline_id: child.id, reason: "scale" } as Json,
    },
    {
      pipeline_id: child.id,
      kind: "stage_advanced",
      stage: "configuration",
      payload: { spawned_from: parent.id, reason: "scale" } as Json,
    },
  ]);
  if (evErr) {
    console.warn(
      `[pipelines.monitor.decision] spawn lineage event insert failed: ${evErr.message}`,
    );
  }

  return { ok: true, pipelineId: child.id };
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
