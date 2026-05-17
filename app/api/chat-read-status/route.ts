import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ReadStatusBody = z.object({
  creative_id: z.string().min(1),
  last_read_at: z.string().min(1),
});

/**
 * POST /api/chat-read-status
 *
 * Placeholder for the `chat_read_status` table. Today the read marker
 * lives only in `localStorage` on the client; this endpoint accepts
 * the payload, validates it, and returns `{ ok: true }` so the future
 * cut-over (CS agent's chat_read_status migration) is a one-file edit
 * rather than a contract change.
 *
 * Keeping the route live now means:
 *  - The client's `keepalive: true` POST doesn't 404 + log a warning
 *  - The shape of the payload is locked in (`creative_id`, `last_read_at`)
 *  - Anything that needs to read this status before the migration can
 *    rely on a stable URL
 */
export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = ReadStatusBody.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation_failed", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  // TODO(CS): persist to `chat_read_status` once the migration lands.
  // For now: best-effort accept. Returning 200 keeps clients quiet.
  return NextResponse.json({ ok: true, persisted: false });
}
