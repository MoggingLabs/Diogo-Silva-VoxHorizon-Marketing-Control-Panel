import { NextResponse, type NextRequest } from "next/server";

import { conflict, emitEvent, eventKind, notFound, ok, serverError, softDelete } from "@/lib/crud";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import {
  canTransition,
  VideoBriefPatchInput,
  type VideoBrief,
  type VideoBriefUpdateRow,
} from "@/lib/video-briefs";

type Params = { params: Promise<{ id: string }> };

/**
 * GET /api/briefs/video/:id
 */
export async function GET(_req: NextRequest, { params }: Params) {
  const { id } = await params;
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("video_briefs")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!data) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json(data);
}

/**
 * PATCH /api/briefs/video/:id
 *
 * Partial updates + status transitions guarded by the in-app state machine
 * (see `lib/video-briefs.ts#allowedTransitions`).
 *
 *   * 400 — zod validation failure
 *   * 404 — brief not found
 *   * 409 — disallowed status transition (e.g. trying to move an approved
 *           brief back to draft)
 *   * 500 — db error
 *
 * Implements V1-4 (#81).
 */
export async function PATCH(req: NextRequest, { params }: Params) {
  const { id } = await params;
  const body = (await req.json().catch(() => null)) as unknown;
  if (body == null) {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = VideoBriefPatchInput.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const input = parsed.data;

  const supabase = await createClient();

  // Read current row so we can validate the transition.
  const { data: current, error: readErr } = await supabase
    .from("video_briefs")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (readErr) {
    return NextResponse.json(
      { error: `Failed to read video brief: ${readErr.message}` },
      { status: 500 },
    );
  }
  if (!current) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // State machine guard. We only check when a status change is requested
  // and the target differs from the current state; a no-op is allowed.
  if (input.status && input.status !== current.status) {
    if (!canTransition(current.status, input.status)) {
      return NextResponse.json(
        {
          error: `Disallowed transition: ${current.status} → ${input.status}`,
        },
        { status: 409 },
      );
    }
  }

  // Build the update payload. We only forward keys that were actually
  // supplied (so we don't accidentally null-out other columns).
  const update: VideoBriefUpdateRow = {};
  if (input.script_outline !== undefined) update.script_outline = input.script_outline;
  if (input.target_duration_s !== undefined) update.target_duration_s = input.target_duration_s;
  if (input.voice_id !== undefined) update.voice_id = input.voice_id;
  if (input.music_track !== undefined) update.music_track = input.music_track;
  if (input.hook_style !== undefined) update.hook_style = input.hook_style;
  if (input.dimensions !== undefined) update.dimensions = input.dimensions;
  if (input.captions_style !== undefined) update.captions_style = input.captions_style;
  if (input.broll_selection_mode !== undefined)
    update.broll_selection_mode = input.broll_selection_mode;

  // Merge notes into the payload jsonb without clobbering other keys.
  if (input.notes !== undefined || input.payload !== undefined) {
    const existingPayload =
      typeof current.payload === "object" &&
      current.payload !== null &&
      !Array.isArray(current.payload)
        ? (current.payload as Record<string, unknown>)
        : {};
    update.payload = {
      ...existingPayload,
      ...(input.payload ?? {}),
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
    };
  }

  let transitionEvent: string | null = null;
  if (input.status && input.status !== current.status) {
    update.status = input.status;
    transitionEvent = `video_brief_${current.status}_to_${input.status}`;
    if (input.status === "posted") {
      update.posted_at = new Date().toISOString();
    }
  }

  const { data: updated, error: updateErr } = await supabase
    .from("video_briefs")
    .update(update)
    .eq("id", id)
    .select()
    .single();
  if (updateErr || !updated) {
    return NextResponse.json(
      {
        error: `Failed to update video brief: ${updateErr?.message ?? "unknown error"}`,
      },
      { status: 500 },
    );
  }

  // Emit an event for status transitions. Edits without a status change
  // also get a `video_brief_edited` event so the timeline reflects them.
  const kind = transitionEvent ?? "video_brief_edited";
  const { error: eventErr } = await supabase.from("events").insert({
    kind,
    ref_table: "video_briefs",
    ref_id: updated.id,
    payload: {
      brief_id_human: updated.brief_id_human,
      from: current.status,
      to: updated.status,
      keys: Object.keys(update),
    },
  });
  if (eventErr) {
    console.error(`[PATCH /api/briefs/video/${id}] event insert failed: ${eventErr.message}`);
  }

  return NextResponse.json(updated, { status: 200 });
}

/**
 * DELETE /api/briefs/video/:id
 *
 * Archive (soft-delete) a video brief: stamps `deleted_at = now()` so it drops
 * out of the active list while its lineage stays intact. Reversible via
 * `POST /api/briefs/video/:id/restore`.
 *
 * Compare-and-set: only a currently-live row is archived. A double-archive is
 * 409 (already archived); a missing row is 404. Emits a `video_brief_archived`
 * audit event (non-fatal).
 */
export async function DELETE(_req: NextRequest, { params }: Params) {
  const { id } = await params;
  const supabase = createAdminClient();

  const result = await softDelete<VideoBrief>(supabase, "video_briefs", id);

  switch (result.kind) {
    case "ok":
      await emitEvent(supabase, {
        kind: eventKind("video_brief", "archived"),
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
