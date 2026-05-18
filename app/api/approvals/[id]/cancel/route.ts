import { NextResponse, type NextRequest } from "next/server";

import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * POST /api/approvals/:id/cancel
 *
 * Flip a pending approval to `cancelled`. Idempotent: cancelling an
 * already-decided / already-cancelled row returns 200 with the current
 * state and `{cancelled:false}`, matching the worker-side route.
 */
export async function POST(_req: NextRequest, ctx: RouteContext) {
  const { id } = await ctx.params;
  if (!id) {
    return NextResponse.json({ error: "missing id" }, { status: 400 });
  }

  const supabase = createAdminClient();

  const decided_at = new Date().toISOString();
  const { data: updated, error: updateErr } = await supabase
    .from("approvals")
    .update({ status: "cancelled", decided_at })
    .eq("id", id)
    .eq("status", "pending")
    .select()
    .maybeSingle();

  if (updateErr) {
    return NextResponse.json({ error: updateErr.message }, { status: 500 });
  }
  if (updated) {
    return NextResponse.json({ cancelled: true, approval: updated });
  }

  // Either gone or already non-pending — re-read for the response payload.
  const { data: existing, error: readErr } = await supabase
    .from("approvals")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (readErr) {
    return NextResponse.json({ error: readErr.message }, { status: 500 });
  }
  if (!existing) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return NextResponse.json({ cancelled: false, approval: existing });
}
