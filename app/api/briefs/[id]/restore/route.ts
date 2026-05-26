import { type NextRequest } from "next/server";

import { conflict, emitEvent, eventKind, notFound, ok, restore, serverError } from "@/lib/crud";
import type { Brief } from "@/lib/briefs";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * POST /api/briefs/:id/restore
 *
 * Un-archive a soft-deleted brief: clears `deleted_at` so it reappears in the
 * active Briefs list. The mirror of `DELETE /api/briefs/:id`.
 *
 * Compare-and-set: only a currently-archived row (`deleted_at is not null`) is
 * restored. Restoring an already-active row is reported as 409 (not archived);
 * a missing row is 404. On success we emit a `brief_restored` audit event
 * (non-fatal) and return the restored row.
 */
export async function POST(_req: NextRequest, ctx: RouteContext) {
  const { id } = await ctx.params;
  const supabase = createAdminClient();

  const result = await restore<Brief>(supabase, "briefs", id);

  switch (result.kind) {
    case "ok":
      await emitEvent(supabase, {
        kind: eventKind("brief", "restored"),
        refTable: "briefs",
        refId: id,
        payload: null,
      });
      return ok({ brief: result.row });
    case "missing":
      return notFound();
    case "conflict":
      return conflict(result.reason);
    case "error":
      return serverError(result.message);
  }
}
