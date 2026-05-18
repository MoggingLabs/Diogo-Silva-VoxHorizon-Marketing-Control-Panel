import { NextResponse, type NextRequest } from "next/server";

import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * GET /api/approvals/:id
 *
 * Returns one `approvals` row by id. 404 when the row is missing — used by
 * the modal "open by URL" + the e2e seed/verify loop.
 */
export async function GET(_req: NextRequest, ctx: RouteContext) {
  const { id } = await ctx.params;
  if (!id) {
    return NextResponse.json({ error: "missing id" }, { status: 400 });
  }
  const supabase = createAdminClient();
  const { data, error } = await supabase.from("approvals").select("*").eq("id", id).maybeSingle();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!data) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return NextResponse.json({ approval: data });
}
