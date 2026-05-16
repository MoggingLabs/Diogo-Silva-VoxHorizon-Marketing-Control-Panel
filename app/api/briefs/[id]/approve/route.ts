import { NextResponse, type NextRequest } from "next/server";

import { DecisionInput, type BriefUpdate } from "@/lib/briefs";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/types.gen";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * POST /api/briefs/:id/approve
 *
 * The approval gate. Operator-only decision endpoint that records one of
 * three outcomes and stamps `decided_at` / `decided_notes` / `decided_by`.
 *
 * Requirements:
 *   - Brief MUST be in status `posted` — else 409.
 *   - For `approved_with_changes` and `rejected`, `notes` is required and
 *     non-empty (enforced by `DecisionInput`).
 *
 * Side effect: emits `events.kind = 'brief_decided'` with the decision +
 * notes preserved in the event payload.
 */
export async function POST(req: NextRequest, ctx: RouteContext) {
  const { id } = await ctx.params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = DecisionInput.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation_failed", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const { decision, notes } = parsed.data;

  const supabase = createAdminClient();

  const { data: current, error: fetchErr } = await supabase
    .from("briefs")
    .select("id, status")
    .eq("id", id)
    .maybeSingle();

  if (fetchErr) return NextResponse.json({ error: fetchErr.message }, { status: 500 });
  if (!current) return NextResponse.json({ error: "not found" }, { status: 404 });

  if (current.status !== "posted") {
    return NextResponse.json(
      { error: "invalid_state", current: current.status, expected: "posted" },
      { status: 409 },
    );
  }

  const update: BriefUpdate = {
    status: decision,
    decided_at: new Date().toISOString(),
    decided_by: "operator",
    decided_notes: notes ?? null,
  };

  const { data: brief, error: updateErr } = await supabase
    .from("briefs")
    .update(update)
    .eq("id", id)
    .select()
    .single();

  if (updateErr || !brief) {
    return NextResponse.json({ error: updateErr?.message ?? "update failed" }, { status: 500 });
  }

  const { error: evErr } = await supabase.from("events").insert({
    kind: "brief_decided",
    ref_table: "briefs",
    ref_id: brief.id,
    payload: { decision, notes: notes ?? null } as Json,
  });
  if (evErr) {
    console.warn(`[briefs.approve] event insert failed: ${evErr.message}`);
  }

  return NextResponse.json({ brief });
}
