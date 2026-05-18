import { NextResponse, type NextRequest } from "next/server";

import { chatAbort } from "@/lib/hermes/client";
import { HermesError } from "@/lib/hermes/client";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * POST /api/creatives/:id/chat/abort
 *
 * Send SIGTERM into the live `hermes chat` exec for an image-creative
 * chat session. The session id we use upstream is the creative id —
 * the matching POST `/api/creatives/:id/chat` route opens the stream
 * with `session_id = id`, so this route only needs the path parameter.
 *
 * The browser ALSO calls `controller.abort()` on its `fetch` — that
 * cancels the local connection immediately. This server-side abort is
 * a belt-and-braces signal so the upstream Hermes exec stops generating
 * tokens we'll never see.
 *
 * Returns:
 *   200 `{ aborted: true }` when the bridge confirmed a live exec was
 *     signalled.
 *   200 `{ aborted: false }` when the bridge replied 404 (no live
 *     session). The browser code path stays simple — a missing session
 *     after the operator clicks Stop is benign.
 *   404 when the creative row itself doesn't exist (auth gate).
 *   500 on Supabase failure.
 *   502 on worker connection error.
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

  try {
    const result = await chatAbort({ session_id: id });
    return NextResponse.json({ aborted: result.aborted });
  } catch (err) {
    // The bridge returns 404 when no live exec matches the session_id —
    // treat that as a clean "nothing to abort" rather than an error so
    // the UI's Stop button stays idempotent.
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
