import { type NextRequest } from "next/server";

import { conflict, emitEvent, eventKind, notFound, ok, restore, serverError } from "@/lib/crud";
import type { Creative } from "@/lib/creatives";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * POST /api/creatives/:id/restore
 *
 * Un-archive a soft-deleted image creative: clears `deleted_at` so it reappears
 * in the active grid. The mirror of `DELETE /api/creatives/:id`.
 *
 * Compare-and-set: only a currently-archived row (`deleted_at is not null`) is
 * restored. Restoring an already-active row is 409 (not archived); a missing
 * row is 404. Emits a non-fatal `creative_restored` audit event on success.
 */
export async function POST(_req: NextRequest, ctx: RouteContext) {
  const { id } = await ctx.params;
  const supabase = createAdminClient();

  const result = await restore<Creative>(supabase, "creatives", id);

  switch (result.kind) {
    case "ok":
      await emitEvent(supabase, {
        kind: eventKind("creative", "restored"),
        refTable: "creatives",
        refId: id,
        payload: null,
      });
      return ok({ creative: result.row });
    case "missing":
      return notFound();
    case "conflict":
      return conflict(result.reason);
    case "error":
      return serverError(result.message);
  }
}
