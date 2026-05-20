import { NextResponse, type NextRequest } from "next/server";

import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/creatives/[id]/iterations
 *
 * Lists the iteration thread for a single image creative, oldest first.
 * Replaces the client-side `supabase.from("creative_iterations").select(...)`
 * read in `SidePanel` that stopped returning rows under RLS deny-all. Reads
 * via the service-role client; gated by Caddy basic auth.
 *
 * Returns: `{ iterations: CreativeIteration[] }`.
 */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!id) {
    return NextResponse.json({ error: "missing_id" }, { status: 400 });
  }

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("creative_iterations")
    .select("*")
    .eq("creative_id", id)
    .order("created_at", { ascending: true })
    .limit(500);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ iterations: data ?? [] });
}
