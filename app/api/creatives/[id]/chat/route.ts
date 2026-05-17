import { NextResponse, type NextRequest } from "next/server";

import { ChatRequest } from "@/lib/chat";
import { buildChatContext } from "@/lib/chat-context";
import { cleanEnv } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * POST /api/creatives/:id/chat
 *
 * Server-Sent Events proxy: forwards a chat exchange from the browser
 * to the local worker (over Tailscale) and streams the SSE response
 * back. The browser-side `<EkkoChat />` consumes this endpoint.
 *
 * Why a proxy?
 *   - The worker's bearer secret never reaches the browser.
 *   - Authorisation (does this creative belong to a brief?) lives here
 *     rather than on the worker.
 *   - The Next.js side owns retry / heartbeat / error normalization.
 *   - The Next.js side hydrates the agent context (brief + creative +
 *     iteration tail + chat tail + tool catalog) via `buildChatContext`
 *     so the worker doesn't need its own service-role Supabase client.
 *
 * Request body shape: see `lib/chat.ts` (`ChatRequest`).
 * Response shape: `text/event-stream` per `lib/chat.ts` doc.
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

  // Authorise: the creative must exist. We don't yet have per-user auth
  // (single-operator app), but we still confirm the row to avoid
  // proxying chat for a fake id.
  const supabase = createAdminClient();
  const { data: creative, error: fetchErr } = await supabase
    .from("creatives")
    .select("id, brief_id")
    .eq("id", id)
    .maybeSingle();
  if (fetchErr) {
    return NextResponse.json({ error: fetchErr.message }, { status: 500 });
  }
  if (!creative) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  // Build the agent context payload — brief + creative + last-N iterations
  // + last-N chat messages + tool catalog. Failures here are unexpected
  // (the creative exists) so we surface them as 500s.
  let context;
  try {
    context = await buildChatContext(supabase, {
      creative_id: id,
      creative_type: "image",
    });
  } catch (e) {
    return NextResponse.json({ error: "context_build_failed", detail: String(e) }, { status: 500 });
  }

  const workerBase = cleanEnv("WORKER_URL").replace(/\/$/, "");
  const secret = cleanEnv("WORKER_SHARED_SECRET");

  let upstream: Response;
  try {
    upstream = await fetch(`${workerBase}/work/chat/creative`, {
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
        context,
      }),
      // Disable Next.js fetch caching for streamed responses.
      cache: "no-store",
      // SSE needs an open connection — let it block indefinitely.
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

  // Stream the upstream SSE response straight through. The body is
  // already in the `data:` line format — no transformation needed.
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
