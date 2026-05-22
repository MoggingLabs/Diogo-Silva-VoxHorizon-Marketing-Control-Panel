import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { dispatchOperator, operatorInstruction } from "@/lib/operator/dispatch";
import { type PipelineEventInsert, type PipelineInsert } from "@/lib/pipeline/schemas";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/types.gen";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/pipelines/operator
 *
 * Operator-driven kickoff. This is the supervision cockpit's "hire the
 * operator for a new run" entry point: it creates a fresh pipeline in the
 * `configuration` stage (the same shape `POST /api/pipelines` produces) and
 * then nudges the Hermes operator to start authoring the brief.
 *
 * Body: `{ instruction: string, format_choice?, client_id? }`
 *   - `instruction` — the manager's free-text brief, e.g.
 *     "4 roofing ads, Austin, $99 inspection". Stored on
 *     `config_draft.operator_instruction` so the StageConfiguration form and
 *     the operator both see it, and threaded into the dispatch instruction.
 *   - `format_choice` — defaults to `image` (the operator pipeline is the
 *     image-ad flow).
 *   - `client_id` — optional; the operator/manager can assign one later.
 *
 * Flow (mirrors the create route, plus the dispatch):
 *   1. Insert the pipelines row (status defaults to `configuration`; we seed
 *      `advanced_at.configuration` and store the instruction in config_draft).
 *   2. Emit the bootstrap `stage_advanced` event so the timeline renders.
 *   3. Emit an `operator_dispatched` event so the narration view shows the
 *      handoff immediately (before the operator's own events arrive).
 *   4. Fire-and-forget the worker dispatch. A worker outage does not fail the
 *      request — the pipeline already exists and the manager can retry.
 *
 * Returns the created pipeline with status 201 (same envelope as the create
 * route) so the kickoff UI can redirect straight to the detail page.
 */
/**
 * The manager's "Finals model" choice → (backend, model) for the FINALS
 * (generation) stage. The FREE codex/gpt-image-2 is the default; the paid Kie
 * models are nano-banana-2 / Flux / Seedream. IDEATION is NOT configurable — it
 * always renders on the free codex model server-side, never one of these. This
 * registry mirrors `FINALS_MODELS` in
 * `ekko-skills/pipeline-operator/helper.py` (the operator routes renders by the
 * persisted backend+model). Keep the two in lockstep.
 */
const FINALS_MODELS = {
  "gpt-image-2 (free)": { backend: "openai-codex", model: "gpt-image-2" },
  "nano-banana-2": { backend: "kie", model: "nano-banana-2" },
  Flux: { backend: "kie", model: "flux-2/pro-text-to-image" },
  Seedream: { backend: "kie", model: "bytedance/seedream-v4-text-to-image" },
} as const;

const FINALS_MODEL_LABELS = Object.keys(FINALS_MODELS) as [
  keyof typeof FINALS_MODELS,
  ...(keyof typeof FINALS_MODELS)[],
];
const DEFAULT_FINALS_LABEL: keyof typeof FINALS_MODELS = "gpt-image-2 (free)";

const OperatorKickoffBody = z.object({
  instruction: z.string().trim().min(1, "instruction is required").max(5000),
  format_choice: z.enum(["image", "video", "both"]).default("image"),
  client_id: z.string().uuid().optional(),
  // The finals (generation) image model. Defaults to the FREE codex model;
  // ideation always stays free regardless of this choice.
  finals_model: z.enum(FINALS_MODEL_LABELS).default(DEFAULT_FINALS_LABEL),
});

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = OperatorKickoffBody.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation_failed", issues: parsed.error.issues },
      { status: 422 },
    );
  }
  const { instruction, format_choice, client_id, finals_model } = parsed.data;

  // Resolve the finals model label → (backend, model) and persist it on the
  // pipeline so the operator renders FINALS with the manager's choice. Ideation
  // stays on the free codex model server-side regardless of this.
  const finals = FINALS_MODELS[finals_model];

  const supabase = createAdminClient();
  const now = new Date().toISOString();
  const insert: PipelineInsert = {
    format_choice,
    client_id: client_id ?? null,
    advanced_at: { configuration: now } as unknown as Json,
    config_draft: {
      operator_driven: true,
      operator_instruction: instruction,
      finals_render_label: finals_model,
      finals_render_backend: finals.backend,
      finals_render_model: finals.model,
    } as unknown as Json,
  };

  const { data: pipeline, error: insertErr } = await supabase
    .from("pipelines")
    .insert(insert)
    .select()
    .single();
  if (insertErr || !pipeline) {
    return NextResponse.json({ error: insertErr?.message ?? "insert failed" }, { status: 500 });
  }

  // Bootstrap timeline event + the operator-handoff marker. Both are
  // best-effort: the pipeline row is the primary artifact, so a failed event
  // insert is logged and swallowed rather than rolled back.
  const events: PipelineEventInsert[] = [
    {
      pipeline_id: pipeline.id,
      kind: "stage_advanced",
      stage: "configuration",
      payload: { format_choice, client_id: client_id ?? null } as Json,
    },
    {
      pipeline_id: pipeline.id,
      kind: "operator_dispatched",
      stage: "configuration",
      payload: { instruction, reason: "kickoff" } as Json,
    },
  ];
  const { error: evErr } = await supabase.from("pipeline_events").insert(events);
  if (evErr) {
    console.warn(`[pipelines.operator] event insert failed: ${evErr.message}`);
  }

  // Kick the operator. Fire-and-forget — a worker outage must not fail the
  // kickoff (the pipeline exists; the manager can re-dispatch from the gate).
  void dispatchOperator(
    pipeline.id,
    operatorInstruction("configuration", pipeline.id, instruction),
  ).catch((e) => {
    console.warn(`[pipelines.operator] operator dispatch failed for ${pipeline.id}: ${String(e)}`);
  });

  return NextResponse.json({ pipeline }, { status: 201 });
}
