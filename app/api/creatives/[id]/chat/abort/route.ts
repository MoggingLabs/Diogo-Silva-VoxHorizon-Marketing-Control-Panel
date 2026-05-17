import { NextResponse, type NextRequest } from "next/server";

import { cleanEnv } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * POST /api/creatives/:id/chat/abort
 *
 * Flip the in-memory abort flag for an image-creative chat-with-Ekko
 * session. The browser fires this when the operator clicks the Stop
 * button; the worker's stream coroutine polls the flag between chunks
 * and emits a clean `message_stop` shortly after.
 *
 * The browser ALSO calls `controller.abort()` on its `fetch` — that
 * cancels the local connection immediately. The worker-side abort
 * flag is a belt-and-braces signal so the upstream Anthropic SDK
 * stream stops generating tokens we'll never see.
 *
 * Returns `{ aborted: true }` even when there's no live stream; the
 * flag is idempotent and a 200 keeps the client code path simple.
 */
export async function POST(_req: NextRequest, ctx: RouteContext) {
  const { id } = await ctx.params;

  // Authorise: the creative must exist. Stop is harmless on a missing
  // row but we still 404 so a typo doesn't silently succeed.
  const supabase = createAdminClient();
  const { data: creative, error: fetchErr } = await supabase
    .from("creatives")
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
    const upstream = await fetch(`${workerBase}/work/chat/creative/abort`, {
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
