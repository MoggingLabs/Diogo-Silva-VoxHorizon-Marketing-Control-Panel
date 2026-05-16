import { NextResponse, type NextRequest } from "next/server";

import { createClient } from "@/lib/supabase/server";
import { DecisionInput, type VideoBriefUpdateRow } from "@/lib/video-briefs";

type Params = { params: Promise<{ id: string }> };

/**
 * POST /api/briefs/video/:id/approve
 *
 * Specialised endpoint for the approval gate. Requires the brief to be in
 * the `posted` state — any other state returns 409. Sets `status`,
 * `decided_at`, `decided_notes`, `decided_by` and emits a
 * `video_brief_decided` event.
 *
 *   * 400 — invalid decision payload (incl. missing notes for
 *           `approved_with_changes` / `rejected`).
 *   * 404 — brief not found.
 *   * 409 — brief is not in `posted` state.
 *   * 500 — db error.
 *
 * Worker dispatch for downstream script generation lands in V2-1 (out of
 * scope for this PR).
 *
 * Implements V1-5 (#82) and the required-notes rule from V1-9 (#86).
 */
export async function POST(req: NextRequest, { params }: Params) {
  const { id } = await params;
  const body = (await req.json().catch(() => null)) as unknown;
  if (body == null) {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = DecisionInput.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const { decision, notes } = parsed.data;

  const supabase = await createClient();

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

  if (current.status !== "posted") {
    return NextResponse.json(
      {
        error: `Cannot decide a brief in status "${current.status}"; must be "posted".`,
      },
      { status: 409 },
    );
  }

  const decidedAt = new Date().toISOString();
  const update: VideoBriefUpdateRow = {
    status: decision,
    decided_at: decidedAt,
    decided_notes: notes ?? null,
    // v1 single-operator app — see `db/SCHEMA.md` for the RLS / identity
    // model. Hard-code the operator until we wire up auth.
    decided_by: "operator",
  };

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

  const { error: eventErr } = await supabase.from("events").insert({
    kind: "video_brief_decided",
    ref_table: "video_briefs",
    ref_id: updated.id,
    payload: {
      brief_id_human: updated.brief_id_human,
      from: current.status,
      to: updated.status,
      decision,
      notes: notes ?? null,
    },
  });
  if (eventErr) {
    console.error(
      `[POST /api/briefs/video/${id}/approve] event insert failed: ${eventErr.message}`,
    );
  }

  // V2-1 hook: when the decision is `approved` or `approved_with_changes`,
  // we'll enqueue `worker.video.scriptGenerate({briefId: updated.id})`
  // here. Tracked in #88; intentionally a no-op until then.

  return NextResponse.json(updated, { status: 200 });
}
