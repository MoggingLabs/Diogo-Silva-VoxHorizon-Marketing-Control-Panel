import { NextResponse, type NextRequest } from "next/server";

import { chatAbort, HermesError } from "@/lib/hermes/client";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * POST /api/creatives/video/:id/chat/abort
 *
 * Video-creative twin of `/api/creatives/:id/chat/abort`. Sends SIGTERM
 * into the matching `hermes chat` exec for this video creative's chat
 * session. See the image-side route for the rationale.
 */
export async function POST(_req: NextRequest, ctx: RouteContext) {
  const { id } = await ctx.params;

  const supabase = createAdminClient();
  const { data: creative, error: fetchErr } = await supabase
    .from("video_creatives")
    .select("id")
    .eq("id", id)
    .maybeSingle();
  if (fetchErr) {
    return NextResponse.json({ error: fetchErr.message }, { status: 500 });
  }
  if (!creative) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  try {
    const result = await chatAbort({ session_id: id });
    return NextResponse.json({ aborted: result.aborted });
  } catch (err) {
    if (err instanceof HermesError && err.status === 404) {
      return NextResponse.json({ aborted: false });
    }
    if (err instanceof HermesError) {
      return NextResponse.json(
        { error: "worker_error", status: err.status, detail: err.message },
        { status: 502 },
      );
    }
    return NextResponse.json({ error: "worker_unreachable", detail: String(err) }, { status: 502 });
  }
}
