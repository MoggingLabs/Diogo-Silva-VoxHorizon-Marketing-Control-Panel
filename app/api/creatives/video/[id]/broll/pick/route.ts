import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { createAdminClient } from "@/lib/supabase/admin";
import { BrollClip, type BrollClipT } from "@/lib/video-creatives";
import type { Json } from "@/lib/supabase/types.gen";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * POST /api/creatives/video/:id/broll/pick
 *
 * Persist the operator's b-roll picks from the `review_each` selector
 * (V2-18). Body shape:
 *
 *   { picks: BrollClip[] }
 *
 * Each pick is one fully-formed `BrollClipT`. The route replaces the
 * `video_creatives.broll_clips` jsonb column with the new array,
 * appends a `video_iterations` row with `kind = "swap_broll"`, and
 * emits a `video_broll_picked` event.
 *
 * Pre-conditions:
 *  - The video creative must exist.
 *  - At least one pick required (so we don't trash existing data with
 *    an empty array by mistake).
 */
const PickInput = z.object({
  picks: z.array(BrollClip).min(1, "at least one pick is required"),
});

export async function POST(req: NextRequest, ctx: RouteContext) {
  const { id } = await ctx.params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = PickInput.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation_failed", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const supabase = createAdminClient();

  const { data: current, error: fetchErr } = await supabase
    .from("video_creatives")
    .select("id, brief_id, broll_clips")
    .eq("id", id)
    .maybeSingle();
  if (fetchErr) {
    return NextResponse.json({ error: fetchErr.message }, { status: 500 });
  }
  if (!current) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const picks: BrollClipT[] = parsed.data.picks;

  const { data: updated, error: updateErr } = await supabase
    .from("video_creatives")
    .update({ broll_clips: picks as unknown as Json })
    .eq("id", id)
    .select()
    .single();
  if (updateErr || !updated) {
    return NextResponse.json({ error: updateErr?.message ?? "update failed" }, { status: 500 });
  }

  // Append iteration row (audit trail) — non-fatal on failure.
  const { error: itErr } = await supabase.from("video_iterations").insert({
    creative_id: id,
    author: "user",
    kind: "swap_broll",
    content: { picks: picks as unknown as Json } as Json,
  });
  if (itErr) {
    console.warn(`[broll.pick] iteration insert failed: ${itErr.message}`);
  }

  const { error: evErr } = await supabase.from("events").insert({
    kind: "video_broll_picked",
    ref_table: "video_creatives",
    ref_id: id,
    payload: { count: picks.length } as Json,
  });
  if (evErr) {
    console.warn(`[broll.pick] event insert failed: ${evErr.message}`);
  }

  return NextResponse.json({ creative: updated });
}
