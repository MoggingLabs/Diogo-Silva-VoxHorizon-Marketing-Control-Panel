import { NextResponse, type NextRequest } from "next/server";

import { ChatRequest } from "@/lib/chat";
import { cleanEnv } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * POST /api/creatives/video/:id/chat
 *
 * Server-Sent Events proxy for chat-with-Ekko on a video creative.
 * Mirrors the image-side route (`app/api/creatives/[id]/chat`) but
 * forwards to `/work/chat/video-creative` which exposes the
 * video-pipeline tool set (regenerate_voiceover, swap_broll,
 * rerender_video).
 */
export async function POST(req: NextRequest, ctx: RouteContext) {
  const { id } = await ctx.params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = ChatRequest.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation_failed", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const supabase = createAdminClient();
  const { data: creative, error: fetchErr } = await supabase
    .from("video_creatives")
    .select("id, brief_id")
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

  let upstream: Response;
  try {
    upstream = await fetch(`${workerBase}/work/chat/video-creative`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify({
        creative_id: id,
        messages: parsed.data.messages,
        tools: parsed.data.tools,
        system_prompt: parsed.data.system_prompt,
      }),
      cache: "no-store",
      signal: req.signal,
    });
  } catch (e) {
    return NextResponse.json({ error: "worker_unreachable", detail: String(e) }, { status: 502 });
  }

  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => "");
    return NextResponse.json(
      { error: "worker_error", status: upstream.status, body: text.slice(0, 500) },
      { status: 502 },
    );
  }

  return new Response(upstream.body, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
