import { type NextRequest } from "next/server";

import { conflict, emitEvent, eventKind, notFound, ok, restore, serverError } from "@/lib/crud";
import { createAdminClient } from "@/lib/supabase/admin";
import type { VideoBrief } from "@/lib/video-briefs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/**
 * POST /api/briefs/video/:id/restore
 *
 * Un-archive a soft-deleted video brief: clears `deleted_at` so it reappears in
 * the active Briefs list. The mirror of `DELETE /api/briefs/video/:id`.
 *
 * Compare-and-set: only a currently-archived row is restored. Restoring an
 * already-active row is 409 (not archived); a missing row is 404. Emits a
 * `video_brief_restored` audit event (non-fatal).
 */
export async function POST(_req: NextRequest, { params }: Params) {
  const { id } = await params;
  const supabase = createAdminClient();

  const result = await restore<VideoBrief>(supabase, "video_briefs", id);

  switch (result.kind) {
    case "ok":
      await emitEvent(supabase, {
        kind: eventKind("video_brief", "restored"),
        refTable: "video_briefs",
        refId: id,
        payload: null,
      });
      return ok(result.row);
    case "missing":
      return notFound();
    case "conflict":
      return conflict(result.reason);
    case "error":
      return serverError(result.message);
  }
}
