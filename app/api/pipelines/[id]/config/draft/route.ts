import { NextResponse, type NextRequest } from "next/server";

import { ChatRequest } from "@/lib/chat";
import { cleanEnv } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * POST /api/pipelines/:id/config/draft
 *
 * Server-Sent Events proxy: forwards a brief-strategist interview from the
 * browser to the local worker's `/work/pipeline/config-draft` endpoint and
 * streams the SSE response back. The browser-side `<EkkoDraftModal />`
 * consumes this endpoint.
 *
 * Why a proxy?
 *   - The worker's bearer secret never reaches the browser.
 *   - Authorisation (does this pipeline exist? is it still in
 *     `configuration`?) lives here rather than on the worker.
 *   - The Next.js side normalizes error shapes for the modal.
 *
 * Request body shape: `lib/chat.ts` (`ChatRequest`) — `messages` are the
 * accumulated transcript.
 * Response shape: `text/event-stream`; events follow the standard StreamChunk
 * union. The modal listens for `tool_call_result` with `tool === 'propose_config'`
 * to hydrate the form.
 *
 * Returns:
 *   200 `text/event-stream` on success.
 *   400 on invalid body.
 *   404 if the pipeline doesn't exist.
 *   409 if the pipeline has already advanced past configuration (Ekko
 *       shouldn't be re-drafting a locked stage).
 *   502 on worker unreachable / non-2xx.
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

  // Confirm the pipeline exists + is still in configuration. The worker
  // doesn't have a service-role Supabase client of its own for this stage, so
  // we do the cheap status check here and just send the pipeline_id +
  // transcript downstream.
  const supabase = createAdminClient();
  const { data: pipeline, error: fetchErr } = await supabase
    .from("pipelines")
    .select("id, status, format_choice")
    .eq("id", id)
    .maybeSingle();
  if (fetchErr) {
    return NextResponse.json({ error: fetchErr.message }, { status: 500 });
  }
  if (!pipeline) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  if (pipeline.status !== "configuration") {
    return NextResponse.json(
      { error: "config locked", current_status: pipeline.status },
      { status: 409 },
    );
  }

  const workerBase = cleanEnv("WORKER_URL").replace(/\/$/, "");
  const secret = cleanEnv("WORKER_SHARED_SECRET");

  let upstream: Response;
  try {
    upstream = await fetch(`${workerBase}/work/pipeline/config-draft`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify({
        pipeline_id: id,
        format_choice: pipeline.format_choice,
        messages: parsed.data.messages,
        tools: parsed.data.tools,
        system_prompt: parsed.data.system_prompt,
      }),
      cache: "no-store",
      // The browser may abort mid-stream (Cancel button); propagate so the
      // worker can shut down its Anthropic call. `req.signal` is the
      // upstream-fetch's abort signal.
      signal: req.signal,
    });
  } catch (e) {
    return NextResponse.json({ error: "worker_unreachable", detail: String(e) }, { status: 502 });
  }

  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => "");
    return NextResponse.json(
      {
        error: "worker_error",
        status: upstream.status,
        body: text.slice(0, 500),
      },
      { status: 502 },
    );
  }

  // Stream the upstream SSE response straight through.
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
