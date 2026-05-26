import { type NextRequest } from "next/server";

import { conflict, emitEvent, eventKind, notFound, ok, restore, serverError } from "@/lib/crud";
import { createAdminClient } from "@/lib/supabase/admin";
import type { VideoLaunchPackage } from "@/lib/video-launches";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * POST /api/launches/video/:id/restore
 *
 * Un-archive a soft-deleted video launch package (E5.1 / #595). Mirror of
 * ``DELETE /api/launches/video/:id``. Compare-and-set: an already-active row is
 * 409; a missing row is 404. Emits a non-fatal ``video_launch_package_restored``
 * audit event.
 */
export async function POST(_req: NextRequest, ctx: RouteContext) {
  const { id } = await ctx.params;
  const supabase = createAdminClient();

  const result = await restore<VideoLaunchPackage>(supabase, "video_launch_packages", id);

  switch (result.kind) {
    case "ok":
      await emitEvent(supabase, {
        kind: eventKind("video_launch_package", "restored"),
        refTable: "video_launch_packages",
        refId: id,
        payload: null,
      });
      return ok({ launch: result.row });
    case "missing":
      return notFound();
    case "conflict":
      return conflict(result.reason);
    case "error":
      return serverError(result.message);
  }
}
