import { NextResponse, type NextRequest } from "next/server";

import { ChatRequest } from "@/lib/chat";
import { buildChatContext } from "@/lib/chat-context";
import { chatStream } from "@/lib/hermes/client";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * POST /api/creatives/video/:id/chat
 *
 * Video-creative twin of `/api/creatives/:id/chat`. Forwards the chat
 * exchange to the worker's `/work/hermes/chat` bridge endpoint and
 * streams the SSE response back. The system_prompt carries the video
 * pipeline's full context (script, voiceover path, broll, composed +
 * captioned outputs) plus the video-specific tool catalog
 * (`rewrite_script`, `regenerate_voiceover`, `swap_broll`, ...).
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

  // Hydrate the agent context payload before invoking the bridge.
  let context;
  try {
    context = await buildChatContext(supabase, {
      creative_id: id,
      creative_type: "video",
    });
  } catch (e) {
    return NextResponse.json({ error: "context_build_failed", detail: String(e) }, { status: 500 });
  }

  const systemPrompt = composeSystemPrompt(parsed.data.system_prompt, context, {
    creative_type: "video",
    creative_id: id,
  });

  let upstream: Response;
  try {
    upstream = await chatStream(
      {
        messages: parsed.data.messages,
        session_id: id,
        system_prompt: systemPrompt,
      },
      req.signal,
    );
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

/**
 * Mirror of the image-side `composeSystemPrompt` — kept inline here so
 * the file is self-contained and a future change to one prompt doesn't
 * accidentally cross-pollute the other.
 */
function composeSystemPrompt(
  override: string | undefined,
  context: unknown,
  hint: { creative_type: "image" | "video"; creative_id: string },
): string {
  const lead =
    override?.trim() ||
    `You are Ekko, the operator's creative-iteration agent for a ${hint.creative_type} creative (${hint.creative_id}). Use the provided context to ground your replies and propose tool calls when an action would materially help.`;
  const envelope = JSON.stringify(context);
  return `${lead}\n\n<creative_context>\n${envelope}\n</creative_context>`;
}
