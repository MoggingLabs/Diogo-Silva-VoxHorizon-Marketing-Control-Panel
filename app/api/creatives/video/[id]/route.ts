import { type NextRequest } from "next/server";

import {
  badJson,
  badRequest,
  conflict,
  emitEvent,
  eventKind,
  notFound,
  ok,
  serverError,
  softDelete,
  zodError,
} from "@/lib/crud";
import {
  UpdateVideoCreativeInput,
  type VideoCreative,
  type VideoCreativeUpdate,
} from "@/lib/video-creatives";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/types.gen";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * GET /api/creatives/video/:id
 *
 * Single video-creative fetch for the manage surface (M4 / #594). Returns the
 * row, its video-brief header, the video copy variants tied to it, and the
 * recent `events` timeline — in one round-trip.
 *
 * Returns 404 if the row is missing.
 *
 * Response shape:
 *   {
 *     creative: VideoCreative,
 *     brief: { id, brief_id_human, status, client_id } | null,
 *     copy_variants: VideoCopyVariant[],
 *     events: Event[],
 *   }
 */
export async function GET(_req: NextRequest, ctx: RouteContext) {
  const { id } = await ctx.params;
  const supabase = createAdminClient();

  const { data: creative, error } = await supabase
    .from("video_creatives")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (error) return serverError(error);
  if (!creative) return notFound();

  const [briefRes, copyRes, eventsRes] = await Promise.all([
    supabase
      .from("video_briefs")
      .select("id, brief_id_human, status, client_id")
      .eq("id", creative.brief_id)
      .maybeSingle(),
    supabase
      .from("video_copy_variants")
      .select("*")
      .eq("creative_id", id)
      .order("created_at", { ascending: true })
      .limit(200),
    supabase
      .from("events")
      .select("id, kind, payload, created_at, ref_table, ref_id")
      .eq("ref_table", "video_creatives")
      .eq("ref_id", id)
      .order("created_at", { ascending: false })
      .limit(50),
  ]);

  if (briefRes.error) return serverError(briefRes.error);
  if (copyRes.error) return serverError(copyRes.error);
  if (eventsRes.error) return serverError(eventsRes.error);

  return ok({
    creative,
    brief: briefRes.data ?? null,
    copy_variants: copyRes.data ?? [],
    events: eventsRes.data ?? [],
  });
}

/**
 * PATCH /api/creatives/video/:id
 *
 * Edit the operator-safe descriptive metadata of a video creative
 * (`asset_name`). Validated by `UpdateVideoCreativeInput`.
 *
 * Guardrail: never touches `status` — the video pipeline status flows through
 * `POST /api/creatives/video/:id/decision` (the state machine) — and never the
 * worker-owned render columns (paths, b-roll, duration, cost) or the FK
 * lineage. An empty patch is rejected 400. Emits a non-fatal
 * `video_creative_updated` audit event.
 */
export async function PATCH(req: NextRequest, ctx: RouteContext) {
  const { id } = await ctx.params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return badJson();
  }

  const parsed = UpdateVideoCreativeInput.safeParse(body);
  if (!parsed.success) return zodError(parsed.error);

  const update: VideoCreativeUpdate = {};
  for (const key of ["asset_name"] as const) {
    if (key in parsed.data && parsed.data[key] !== undefined) {
      (update as Record<string, unknown>)[key] = parsed.data[key];
    }
  }

  if (Object.keys(update).length === 0) {
    return badRequest("nothing to update");
  }

  const supabase = createAdminClient();

  const { data: creative, error } = await supabase
    .from("video_creatives")
    .update(update)
    .eq("id", id)
    .is("deleted_at", null)
    .select()
    .maybeSingle();

  if (error) return serverError(error);
  if (!creative) return notFound();

  await emitEvent(supabase, {
    kind: eventKind("video_creative", "updated"),
    refTable: "video_creatives",
    refId: id,
    payload: { fields: Object.keys(update) } as Json,
  });

  return ok({ creative: creative as VideoCreative });
}

/**
 * DELETE /api/creatives/video/:id
 *
 * Archive (soft-delete) a video creative: sets `deleted_at = now()` so it drops
 * out of the active grid but stays restorable. Same "delete = soft-delete"
 * guardrail as the image side. Compare-and-set: double-archive is 409, missing
 * is 404. Emits a non-fatal `video_creative_archived` event.
 */
export async function DELETE(_req: NextRequest, ctx: RouteContext) {
  const { id } = await ctx.params;
  const supabase = createAdminClient();

  const result = await softDelete<VideoCreative>(supabase, "video_creatives", id);

  switch (result.kind) {
    case "ok":
      await emitEvent(supabase, {
        kind: eventKind("video_creative", "archived"),
        refTable: "video_creatives",
        refId: id,
        payload: { deleted_at: result.row.deleted_at },
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
