import { NextResponse, type NextRequest } from "next/server";

import { ApprovalsQuery } from "@/lib/approvals/types";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/approvals
 *
 * Lists approvals from the `approvals` table. Defaults to "pending only" so
 * the queue widget is cheap to mount and the dashboard's auto-poll fallback
 * is a no-op when nothing's outstanding.
 *
 * Query string (all optional, see `lib/approvals/types.ts`):
 *   - status         — `pending|decided|expired|cancelled` (default: pending)
 *   - session        — filter to a single `ekko_session_id`
 *   - tool           — filter to a single `tool_name`
 *   - decision       — filter (only meaningful when status='decided')
 *   - from / to      — ISO timestamps; filter on `requested_at`
 *   - limit          — page size (default 100, max 500)
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const queryRaw: Record<string, unknown> = {};
  for (const k of ["status", "session", "tool", "decision", "from", "to", "limit"] as const) {
    const v = url.searchParams.get(k);
    if (v !== null) queryRaw[k] = v;
  }
  const parsed = ApprovalsQuery.safeParse(queryRaw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation_failed", issues: parsed.error.issues },
      { status: 422 },
    );
  }
  const { status, session, tool, decision, from, to, limit } = parsed.data;
  const effectiveStatus = status ?? "pending";

  const supabase = createAdminClient();
  // The generated types don't yet include the `approvals` table; cast the
  // chain to `any` so column-name typing doesn't reject the new fields.
  // Wave 22 regenerates types and removes this cast.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let q: any = (supabase as any)
    .from("approvals")
    .select("*")
    .order("requested_at", { ascending: false })
    .limit(limit);

  q = q.eq("status", effectiveStatus);
  if (session) q = q.eq("ekko_session_id", session);
  if (tool) q = q.eq("tool_name", tool);
  if (decision) q = q.eq("decision", decision);
  if (from) q = q.gte("requested_at", from);
  if (to) q = q.lte("requested_at", to);

  const { data, error } = await q;
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ approvals: data ?? [] });
}
