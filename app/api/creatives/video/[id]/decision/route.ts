import { NextResponse, type NextRequest } from "next/server";

import {
  VideoDecisionInput,
  canDecide,
  decisionToStatus,
  type VideoCreativeStatusT,
  type VideoCreativeUpdate,
} from "@/lib/video-creatives";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/types.gen";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * POST /api/creatives/video/:id/decision
 *
 * Records the operator's terminal decision on a single video creative.
 * Body shape: `{ decision: "approve" | "reject" }`.
 *
 * Requirements (mirrors the state machine in `lib/video-creatives.ts`):
 *  - `approve` is only valid from status `captioned` — that's when the full
 *    pipeline (script + voiceover + b-roll + compose + caption) has produced
 *    a shippable MP4. Any earlier stage → 409.
 *  - `reject` is valid from any non-terminal status (`draft`,
 *    `script_ready`, `voiceover_ready`, `broll_ready`, `composed`,
 *    `captioned`). Terminal statuses (`approved`, `rejected`) → 409.
 *  - On `approve`: status becomes `approved` and `approved_at` is stamped.
 *  - On `reject`: status becomes `rejected`; `approved_at` left null.
 *
 * Side effect: emits `events.kind = 'video_creative_decided'` with the
 * decision preserved in the payload so the audit log captures the call.
 */
export async function POST(req: NextRequest, ctx: RouteContext) {
  const { id } = await ctx.params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = VideoDecisionInput.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation_failed", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const { decision } = parsed.data;

  const supabase = createAdminClient();

  const { data: current, error: fetchErr } = await supabase
    .from("video_creatives")
    .select("id, status")
    .eq("id", id)
    .maybeSingle();

  if (fetchErr) return NextResponse.json({ error: fetchErr.message }, { status: 500 });
  if (!current) return NextResponse.json({ error: "not found" }, { status: 404 });

  const fromStatus = current.status as VideoCreativeStatusT;
  if (!canDecide(fromStatus, decision)) {
    return NextResponse.json(
      { error: "invalid_state", current: fromStatus, decision },
      { status: 409 },
    );
  }

  const toStatus = decisionToStatus(decision);
  const update: VideoCreativeUpdate = {
    status: toStatus,
    approved_at: decision === "approve" ? new Date().toISOString() : null,
  };

  const { data: creative, error: updateErr } = await supabase
    .from("video_creatives")
    .update(update)
    .eq("id", id)
    .select()
    .single();

  if (updateErr || !creative) {
    return NextResponse.json({ error: updateErr?.message ?? "update failed" }, { status: 500 });
  }

  const { error: evErr } = await supabase.from("events").insert({
    kind: "video_creative_decided",
    ref_table: "video_creatives",
    ref_id: creative.id,
    payload: { decision, from: fromStatus, to: toStatus } as Json,
  });
  if (evErr) {
    // Non-fatal: the decision itself succeeded. Log + continue.
    console.warn(`[video-creatives.decision] event insert failed: ${evErr.message}`);
  }

  return NextResponse.json({ creative });
}
