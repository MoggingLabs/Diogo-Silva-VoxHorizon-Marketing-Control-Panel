import { NextResponse, type NextRequest } from "next/server";

import {
  DecisionInput,
  canDecide,
  decisionToStatus,
  type CreativeStatusT,
  type CreativeUpdate,
} from "@/lib/creatives";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/types.gen";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * POST /api/creatives/:id/decision
 *
 * Records the operator's terminal decision on a single image creative.
 * Body shape: `{ decision: "approve" | "reject" }`.
 *
 * Requirements:
 *   - Creative MUST be in status `draft` — anything else is 409.
 *   - On `approve`: status becomes `approved` and `approved_at` is stamped
 *     with the current timestamp.
 *   - On `reject`: status becomes `rejected`; `approved_at` is left null.
 *
 * Side effect: emits `events.kind = 'creative_decided'` with `{ decision }`
 * preserved in the event payload so the audit log captures the call.
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
  const { decision } = parsed.data;

  const supabase = createAdminClient();

  const { data: current, error: fetchErr } = await supabase
    .from("creatives")
    .select("id, status")
    .eq("id", id)
    .maybeSingle();

  if (fetchErr) return NextResponse.json({ error: fetchErr.message }, { status: 500 });
  if (!current) return NextResponse.json({ error: "not found" }, { status: 404 });

  const fromStatus = current.status as CreativeStatusT;
  if (!canDecide(fromStatus, decision)) {
    return NextResponse.json(
      { error: "invalid_state", current: fromStatus, decision },
      { status: 409 },
    );
  }

  const toStatus = decisionToStatus(decision);
  const update: CreativeUpdate = {
    status: toStatus,
    approved_at: decision === "approve" ? new Date().toISOString() : null,
  };

  const { data: creative, error: updateErr } = await supabase
    .from("creatives")
    .update(update)
    .eq("id", id)
    .select()
    .single();

  if (updateErr || !creative) {
    return NextResponse.json({ error: updateErr?.message ?? "update failed" }, { status: 500 });
  }

  // Silent-failure PR-3 cutover: the legacy console.warn swallow on this
  // events insert is gone -- a failed audit-trail write surfaces as 5xx so
  // the manager retries rather than the row+log silently diverging.
  const { error: evErr } = await supabase.from("events").insert({
    kind: "creative_decided",
    ref_table: "creatives",
    ref_id: creative.id,
    payload: { decision } as Json,
  });
  if (evErr) {
    return NextResponse.json(
      { error: `creative_decided event insert failed: ${evErr.message}` },
      { status: 500 },
    );
  }

  return NextResponse.json({ creative });
}
