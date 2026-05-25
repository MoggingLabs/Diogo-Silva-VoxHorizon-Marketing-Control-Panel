import { NextResponse, type NextRequest } from "next/server";

import { createClient } from "@/lib/supabase/server";
import { VideoBriefInput, type VideoBriefInsertRow } from "@/lib/video-briefs";

/**
 * POST /api/briefs/video
 * POST /api/briefs/video?post=1
 *
 * Validates a video-brief payload via zod, mints a human ID using
 * `gen_video_brief_id_human(client_slug)`, inserts the row, and emits a
 * `video_brief_created` event. The `?post=1` query flag transitions the
 * new row directly to `posted` and stamps `posted_at`.
 *
 * Returns 201 on success, 400 on validation failure, 404 if the client
 * doesn't exist, 500 on database error.
 *
 * Implements V1-3 (#80).
 */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as unknown;
  if (body == null) {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = VideoBriefInput.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const input = parsed.data;

  const shouldPost = req.nextUrl.searchParams.get("post") === "1";
  const supabase = await createClient();

  // 1. Resolve client slug — required to mint the human ID.
  const { data: client, error: clientErr } = await supabase
    .from("clients")
    .select("id, slug")
    .eq("id", input.client_id)
    .maybeSingle();
  if (clientErr) {
    return NextResponse.json(
      { error: `Failed to read client: ${clientErr.message}` },
      { status: 500 },
    );
  }
  if (!client) {
    return NextResponse.json({ error: "Client not found" }, { status: 404 });
  }

  // 2. Mint brief_id_human via the DB helper.
  const { data: idData, error: idErr } = await supabase.rpc(
    // RPC is not in the generated types until functions are typed — cast.
    "gen_video_brief_id_human" as never,
    { p_client_slug: client.slug } as never,
  );
  if (idErr || typeof idData !== "string") {
    return NextResponse.json(
      {
        error: `Failed to mint brief_id_human: ${idErr?.message ?? "unknown error"}`,
      },
      { status: 500 },
    );
  }
  const briefIdHuman = idData;

  // 3. Build the insert row.
  const now = new Date().toISOString();
  const insertRow: VideoBriefInsertRow = {
    brief_id_human: briefIdHuman,
    client_id: input.client_id,
    status: shouldPost ? "posted" : "draft",
    script_outline: input.script_outline,
    target_duration_s: input.target_duration_s,
    voice_id: input.voice_id,
    music_track: input.music_track ?? null,
    hook_style: input.hook_style ?? null,
    dimensions: input.dimensions,
    captions_style: input.captions_style ?? null,
    broll_selection_mode: input.broll_selection_mode,
    payload: {
      notes: input.notes ?? null,
      ...(input.payload ?? {}),
    },
    posted_at: shouldPost ? now : null,
  };

  const { data: inserted, error: insertErr } = await supabase
    .from("video_briefs")
    .insert(insertRow)
    .select()
    .single();
  if (insertErr || !inserted) {
    return NextResponse.json(
      {
        error: `Failed to insert video brief: ${insertErr?.message ?? "unknown error"}`,
      },
      { status: 500 },
    );
  }

  // 4. Emit creation event. Failures here are non-fatal — the brief
  //    exists; the audit log is best-effort. Log to stderr so we notice.
  const { error: eventErr } = await supabase.from("events").insert({
    kind: shouldPost ? "video_brief_posted" : "video_brief_created",
    ref_table: "video_briefs",
    ref_id: inserted.id,
    payload: {
      brief_id_human: inserted.brief_id_human,
      client_id: inserted.client_id,
      status: inserted.status,
    },
  });
  if (eventErr) {
    console.error(
      `[POST /api/briefs/video] event insert failed for ${inserted.id}: ${eventErr.message}`,
    );
  }

  return NextResponse.json(inserted, { status: 201 });
}

/**
 * GET /api/briefs/video
 *
 * Lightweight list endpoint — newest first. Active rows only by default
 * (`deleted_at is null`); `?archived=1` lists archived rows, `?archived=all`
 * includes both. Useful for the optional `/briefs/video` index page and for
 * debugging.
 */
export async function GET(req: NextRequest) {
  const supabase = await createClient();
  const archived = req.nextUrl.searchParams.get("archived");

  let query = supabase
    .from("video_briefs")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(100);

  if (archived === "1" || archived === "true") {
    query = query.not("deleted_at", "is", null);
  } else if (archived !== "all") {
    query = query.is("deleted_at", null);
  }

  const { data, error } = await query;
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ data: data ?? [] });
}
