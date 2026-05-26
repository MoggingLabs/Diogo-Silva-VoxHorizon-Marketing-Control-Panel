import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { activeTracksLocal } from "@/lib/pipeline/transitions";
import type { PipelineEventInsert, PipelineUpdate } from "@/lib/pipeline/schemas";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/types.gen";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * POST /api/pipelines/:id/picks
 *
 * Persists the operator's per-track pick selection for the ideation stage.
 *
 * Body:
 *   { image?: uuid[], video?: uuid[] }
 *
 * Behaviour:
 *   - Idempotent: the new array OVERWRITES the existing `pipelines.picks`
 *     entry for each track present in the body. This is what lets a UI
 *     checkbox toggle behave naturally — uncheck on the client, POST the
 *     shorter array, server writes it back.
 *   - Tracks not present in the body are left untouched (so a future
 *     image-only request doesn't accidentally wipe a video selection on a
 *     `format=both` pipeline).
 *   - Status guard: 409 if `pipelines.status !== 'ideation'`. Letting picks
 *     bleed into other stages would corrupt the downstream gate.
 *   - UUID-membership guard: every uuid in `image[]` must exist in the
 *     `creatives` table with `brief_id = pipeline.image_brief_id`. Same
 *     for `video[]` against `video_creatives`. Foreign uuids → 422 with a
 *     field-level error so the UI can surface "stale selection".
 *   - Foreign track guard: if the body carries `image[]` but the pipeline's
 *     format doesn't include the image track, that's a 422 too. Same for
 *     video. We don't silently drop the array — the client clearly thinks
 *     the track is active and we'd rather signal the mismatch than
 *     pretend-write.
 *   - Emits a `pipeline_events(kind='task_done', stage='ideation',
 *     payload={action: 'picks_recorded', image_count, video_count})` row
 *     so the timeline reflects the operator's curation step.
 */
const PicksBody = z
  .object({
    image: z.array(z.string().uuid()).optional(),
    video: z.array(z.string().uuid()).optional(),
  })
  .refine((b) => b.image !== undefined || b.video !== undefined, {
    message: "at least one of image[] or video[] is required",
  });

type PicksJson = { image?: string[]; video?: string[] };

function readPicks(value: unknown): PicksJson {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const obj = value as Record<string, unknown>;
  const out: PicksJson = {};
  if (Array.isArray(obj.image)) {
    out.image = obj.image.filter((v): v is string => typeof v === "string");
  }
  if (Array.isArray(obj.video)) {
    out.video = obj.video.filter((v): v is string => typeof v === "string");
  }
  return out;
}

export async function POST(req: NextRequest, ctx: RouteContext) {
  const { id } = await ctx.params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = PicksBody.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation_failed", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const supabase = createAdminClient();

  const { data: pipeline, error: readErr } = await supabase
    .from("pipelines")
    .select("id, status, format_choice, picks, image_brief_id, video_brief_id")
    .eq("id", id)
    .maybeSingle();
  if (readErr) {
    return NextResponse.json({ error: readErr.message }, { status: 500 });
  }
  if (!pipeline) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  // Status guard -- only the ideation stage may record picks.
  if (pipeline.status !== "ideation") {
    return NextResponse.json(
      {
        error: "picks_locked",
        current_status: pipeline.status,
      },
      { status: 409 },
    );
  }

  const tracks = activeTracksLocal(pipeline.format_choice);
  const { image: imagePicks, video: videoPicks } = parsed.data;

  // Foreign-track guard: reject picks for an inactive track.
  if (imagePicks !== undefined && !tracks.image) {
    return NextResponse.json(
      {
        error: "validation_failed",
        field: "image",
        reason: "image track is not active for this pipeline",
      },
      { status: 422 },
    );
  }
  if (videoPicks !== undefined && !tracks.video) {
    return NextResponse.json(
      {
        error: "validation_failed",
        field: "video",
        reason: "video track is not active for this pipeline",
      },
      { status: 422 },
    );
  }

  // UUID-membership guard. We dedupe the requested uuids first so a
  // duplicate doesn't break the "every uuid resolved" count check.
  if (imagePicks !== undefined && imagePicks.length > 0) {
    if (!pipeline.image_brief_id) {
      return NextResponse.json(
        {
          error: "validation_failed",
          field: "image",
          reason: "pipeline has no image_brief_id",
        },
        { status: 422 },
      );
    }
    const unique = Array.from(new Set(imagePicks));
    const { data: rows, error: imgErr } = await supabase
      .from("creatives")
      .select("id")
      .eq("brief_id", pipeline.image_brief_id)
      .in("id", unique);
    if (imgErr) {
      return NextResponse.json({ error: imgErr.message }, { status: 500 });
    }
    if ((rows?.length ?? 0) !== unique.length) {
      const found = new Set((rows ?? []).map((r) => r.id));
      const unknownIds = unique.filter((u) => !found.has(u));
      return NextResponse.json(
        {
          error: "validation_failed",
          field: "image",
          reason: "one or more picks do not belong to this pipeline's image brief",
          unknown: unknownIds,
        },
        { status: 422 },
      );
    }
  }

  if (videoPicks !== undefined && videoPicks.length > 0) {
    if (!pipeline.video_brief_id) {
      return NextResponse.json(
        {
          error: "validation_failed",
          field: "video",
          reason: "pipeline has no video_brief_id",
        },
        { status: 422 },
      );
    }
    const unique = Array.from(new Set(videoPicks));
    const { data: rows, error: vidErr } = await supabase
      .from("video_creatives")
      .select("id")
      .eq("brief_id", pipeline.video_brief_id)
      .in("id", unique);
    if (vidErr) {
      return NextResponse.json({ error: vidErr.message }, { status: 500 });
    }
    if ((rows?.length ?? 0) !== unique.length) {
      const found = new Set((rows ?? []).map((r) => r.id));
      const unknownIds = unique.filter((u) => !found.has(u));
      return NextResponse.json(
        {
          error: "validation_failed",
          field: "video",
          reason: "one or more picks do not belong to this pipeline's video brief",
          unknown: unknownIds,
        },
        { status: 422 },
      );
    }
  }

  // Merge: replace the per-track array when present, leave the other alone.
  const existing = readPicks(pipeline.picks);
  const nextPicks: PicksJson = { ...existing };
  if (imagePicks !== undefined) {
    nextPicks.image = Array.from(new Set(imagePicks));
  }
  if (videoPicks !== undefined) {
    nextPicks.video = Array.from(new Set(videoPicks));
  }

  const update: PipelineUpdate = {
    picks: nextPicks as unknown as Json,
  };
  const { data: updated, error: updateErr } = await supabase
    .from("pipelines")
    .update(update)
    .eq("id", pipeline.id)
    // Re-assert the status guard at write time so a concurrent advance
    // can't race past our pre-check.
    .eq("status", "ideation")
    .select()
    .single();
  if (updateErr || !updated) {
    return NextResponse.json(
      { error: updateErr?.message ?? "picks update failed" },
      { status: 500 },
    );
  }

  // Emit the timeline event. Failure is non-fatal — the row is the
  // primary artifact and the timeline can be re-derived if needed.
  const event: PipelineEventInsert = {
    pipeline_id: pipeline.id,
    kind: "task_done",
    stage: "ideation",
    payload: {
      action: "picks_recorded",
      image_count: nextPicks.image?.length ?? 0,
      video_count: nextPicks.video?.length ?? 0,
    } as Json,
  };
  const { error: evErr } = await supabase.from("pipeline_events").insert(event);
  if (evErr) {
    console.warn(`[pipelines.picks] event insert failed: ${evErr.message}`);
  }

  // Note: recording picks does NOT dispatch the operator. The operator renders
  // finals only after the manager approves at the Review gate
  // (/review/decision), which is the single dispatch point for generation —
  // dispatching here too would be premature (the operator would just stand by)
  // and risk a redundant second render.

  return NextResponse.json({ pipeline: updated, picks: nextPicks });
}
