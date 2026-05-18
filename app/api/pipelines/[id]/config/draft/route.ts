import { NextResponse, type NextRequest } from "next/server";

import { ChatRequest } from "@/lib/chat";
import { chatStream } from "@/lib/hermes/client";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * POST /api/pipelines/:id/config/draft
 *
 * Server-Sent Events proxy: forwards a brief-strategist interview from
 * the browser to the worker's `/work/hermes/chat` bridge endpoint and
 * streams the SSE response back. The browser-side `<EkkoDraftModal />`
 * consumes this endpoint via `lib/chat.ts`'s `readChatStream`, and
 * listens for `tool_call_result` events with `tool === 'propose_config'`
 * to hydrate the configuration form.
 *
 * Why a proxy?
 *   - The worker's bearer secret never reaches the browser.
 *   - Authorisation (does this pipeline exist? is it still in
 *     `configuration`?) lives here rather than on the worker.
 *   - The Next.js side normalizes error shapes for the modal.
 *
 * The bridge picks the latest user message as `-q "..."` and runs it
 * through the agent's `propose_config` tool, so the system_prompt is
 * how we communicate "you are drafting a marketing brief for pipeline
 * <id> in format <format_choice>; emit a propose_config tool call when
 * you have enough information".
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

  // Confirm the pipeline exists + is still in configuration.
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

  // Build the config-drafter system prompt. Callers may pass an
  // override — for tests + the rare ad-hoc "act as X" experiment — but
  // by default we describe the agent's job and the format the
  // pipeline expects (image / video / both).
  const systemPrompt = composeDraftSystemPrompt(parsed.data.system_prompt, {
    pipeline_id: pipeline.id,
    format_choice: pipeline.format_choice,
  });

  let upstream: Response;
  try {
    upstream = await chatStream(
      {
        messages: parsed.data.messages,
        // Use the pipeline id as the bridge session id so the abort
        // surface (when we wire one for draft) can target this exec.
        session_id: `pipeline-config-${pipeline.id}`,
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
 * Compose the system prompt for the brief-drafting agent. The override
 * wins when present so we can swap personas in tests without touching
 * the route. The default copy mirrors how the legacy worker route
 * described the task — keep this string aligned with whatever the
 * agent expects to see at the top of its context window.
 */
function composeDraftSystemPrompt(
  override: string | undefined,
  hint: { pipeline_id: string; format_choice: string | null },
): string {
  if (override?.trim()) return override;
  const format = hint.format_choice ?? "image";
  return [
    "You are Ekko, a brief-drafting strategist helping the operator configure a new marketing pipeline.",
    `Pipeline id: ${hint.pipeline_id}. Target format: ${format}.`,
    "Ask focused questions (audience, offer, distinctive angle, tone). When you have enough information,",
    "emit a `propose_config` tool call with the validated payload so the operator can review and accept it.",
  ].join(" ");
}
