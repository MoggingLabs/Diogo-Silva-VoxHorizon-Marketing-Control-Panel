import { NextResponse, type NextRequest } from "next/server";

import { cleanEnv } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * POST /api/creatives/video/:id/chat/abort
 *
 * Video-creative twin of `/api/creatives/:id/chat/abort`. Flips the
 * in-memory abort flag on the worker so its streaming coroutine emits
 * a clean `message_stop` after the next poll. See the image-side
 * route for the rationale.
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

  const workerBase = cleanEnv("WORKER_URL").replace(/\/$/, "");
  const secret = cleanEnv("WORKER_SHARED_SECRET");

  try {
    const upstream = await fetch(`${workerBase}/work/chat/video-creative/abort`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ creative_id: id }),
      cache: "no-store",
    });
    if (!upstream.ok) {
      const text = await upstream.text().catch(() => "");
      return NextResponse.json(
        { error: "worker_error", status: upstream.status, body: text.slice(0, 500) },
        { status: 502 },
      );
    }
    return NextResponse.json({ aborted: true });
  } catch (e) {
    return NextResponse.json({ error: "worker_unreachable", detail: String(e) }, { status: 502 });
  }
}
