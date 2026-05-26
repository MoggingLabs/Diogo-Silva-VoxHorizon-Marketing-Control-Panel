import { NextResponse, type NextRequest } from "next/server";

import {
  badJson,
  conflict,
  emitEvent,
  eventKind,
  notFound,
  ok,
  serverError,
  softDelete,
  zodError,
} from "@/lib/crud";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  VideoLaunchPackageUpdateInput,
  type VideoLaunchPackage,
  type VideoLaunchPackageUpdate,
} from "@/lib/video-launches";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * GET /api/launches/video/:id
 *
 * Read a single video launch package.
 */
export async function GET(_req: NextRequest, ctx: RouteContext) {
  const { id } = await ctx.params;

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("video_launch_packages")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ launch: data });
}

/**
 * PATCH /api/launches/video/:id
 *
 * Operator package edit (E5.1 / #595). Mirror of the image-side PATCH: the
 * editable surface is the operator annotation (``decided_notes``) only; the
 * launch decision flows through the decision route and the ad_entity graph is
 * worker/Meta-owned. Emits a non-fatal ``video_launch_package_updated`` event.
 */
export async function PATCH(req: NextRequest, ctx: RouteContext) {
  const { id } = await ctx.params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return badJson();
  }

  const parsed = VideoLaunchPackageUpdateInput.safeParse(body);
  if (!parsed.success) return zodError(parsed.error);

  const supabase = createAdminClient();

  const update: VideoLaunchPackageUpdate = parsed.data;
  const { data: launch, error: updateErr } = await supabase
    .from("video_launch_packages")
    .update(update)
    .eq("id", id)
    .is("deleted_at", null)
    .select()
    .maybeSingle();
  if (updateErr) return serverError(updateErr.message);
  if (!launch) return notFound();

  await emitEvent(supabase, {
    kind: eventKind("video_launch_package", "updated"),
    refTable: "video_launch_packages",
    refId: id,
    payload: parsed.data,
  });

  return ok({ launch });
}

/**
 * DELETE /api/launches/video/:id
 *
 * Soft-archive a video launch package (E5.1 / #595). Video launch packages
 * carry a ``deleted_at`` tombstone (migration 0047). Compare-and-set: a
 * double-archive is 409; a missing row is 404. Emits a non-fatal
 * ``video_launch_package_archived`` audit event.
 */
export async function DELETE(_req: NextRequest, ctx: RouteContext) {
  const { id } = await ctx.params;
  const supabase = createAdminClient();

  const result = await softDelete<VideoLaunchPackage>(supabase, "video_launch_packages", id);

  switch (result.kind) {
    case "ok":
      await emitEvent(supabase, {
        kind: eventKind("video_launch_package", "archived"),
        refTable: "video_launch_packages",
        refId: id,
        payload: { deleted_at: result.row.deleted_at },
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
