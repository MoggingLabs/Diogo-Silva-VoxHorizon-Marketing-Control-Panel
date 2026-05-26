import { NextResponse, type NextRequest } from "next/server";

import { conflict, emitEvent, eventKind, notFound, ok, restore, serverError } from "@/lib/crud";
import {
  CopyFormat,
  copyTableFor,
  type CopyVariant,
  type VideoCopyVariant,
} from "@/lib/copy/schemas";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * POST /api/copy/:id/restore?format=image|video
 *
 * Un-archive a soft-deleted standalone copy variant. `format` selects the
 * table. Compare-and-set: only an archived row is restored (409 if already
 * live, 404 if missing). Emits a `*_restored` audit event.
 */
export async function POST(req: NextRequest, ctx: RouteContext) {
  const { id } = await ctx.params;
  const formatParam = new URL(req.url).searchParams.get("format") ?? "image";
  const fmt = CopyFormat.safeParse(formatParam);
  if (!fmt.success) {
    return NextResponse.json({ error: "format must be image or video" }, { status: 400 });
  }
  const table = copyTableFor(fmt.data);
  const resource = fmt.data === "video" ? "video_copy_variant" : "copy_variant";
  const supabase = createAdminClient();

  const result = await restore<CopyVariant | VideoCopyVariant>(supabase, table, id);
  switch (result.kind) {
    case "ok":
      await emitEvent(supabase, {
        kind: eventKind(resource, "restored"),
        refTable: table,
        refId: id,
        payload: null,
      });
      return ok({ variant: result.row });
    case "missing":
      return notFound();
    case "conflict":
      return conflict(result.reason);
    case "error":
      return serverError(result.message);
  }
}
