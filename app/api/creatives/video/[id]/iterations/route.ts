import { NextResponse, type NextRequest } from "next/server";

import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/creatives/video/[id]/iterations
 *
 * Lists the iteration thread for a single video creative, oldest first.
 * Replaces the client-side `supabase.from("video_iterations").select(...)`
 * read in `VideoSidePanel` that stopped returning rows under RLS deny-all.
 * Reads via the service-role client; gated by Caddy basic auth.
 *
 * Returns: `{ iterations: VideoIteration[] }`.
 */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!id) {
    return NextResponse.json({ error: "missing_id" }, { status: 400 });
  }

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("video_iterations")
    .select("*")
    .eq("creative_id", id)
    .order("created_at", { ascending: true })
    .limit(500);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ iterations: data ?? [] });
}
