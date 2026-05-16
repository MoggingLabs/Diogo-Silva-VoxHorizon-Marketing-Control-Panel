import { NextResponse, type NextRequest } from "next/server";

import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * GET /api/launches/:id
 *
 * Read a single launch package with the associated brief reference.
 * Used by the detail page client refresh after a decision is recorded.
 */
export async function GET(_req: NextRequest, ctx: RouteContext) {
  const { id } = await ctx.params;

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("launch_packages")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ launch: data });
}
