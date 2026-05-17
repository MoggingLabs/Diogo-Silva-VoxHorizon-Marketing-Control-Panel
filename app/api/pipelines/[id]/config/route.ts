import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { PipelineFormat } from "@/lib/pipeline/schemas";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/types.gen";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Patch-body schema for autosaving pieces of the Configuration stage draft.
 *
 * Every field is optional; the client may PATCH a single key at a time as the
 * operator edits the form. We accept jsonb-y `record(unknown)` for the two
 * brief payloads here because the canonical zod parse runs at advance time
 * (where the row actually lands in `briefs` / `video_briefs`). Validating the
 * full brief shape on every keystroke would burn a lot of CPU and force the
 * operator to fill in every required field before any autosave succeeded,
 * which defeats the purpose of an incremental draft.
 *
 * The `.refine` rejects an empty body — callers must send at least one
 * field. Returning a 400 on an empty PATCH is more useful than silently no-op'ing.
 */
const ConfigPatchBody = z
  .object({
    format_choice: PipelineFormat.optional(),
    image_payload: z.record(z.string(), z.unknown()).nullable().optional(),
    video_payload: z.record(z.string(), z.unknown()).nullable().optional(),
    client_id: z.string().uuid().nullable().optional(),
    // Free-text rationale we accept whenever Ekko hands a draft over. Capped
    // so a runaway Ekko response can't blow up jsonb size.
    notes: z.string().max(5000).nullable().optional(),
  })
  .refine(
    (b) =>
      b.format_choice !== undefined ||
      b.image_payload !== undefined ||
      b.video_payload !== undefined ||
      b.client_id !== undefined ||
      b.notes !== undefined,
    { message: "at least one field is required" },
  );

/**
 * Merge a partial patch into the existing `config_draft` jsonb. We do this in
 * TypeScript (read row → merge → update) rather than via PostgreSQL's
 * `jsonb_set` because the Supabase client doesn't expose `jsonb_set` directly
 * and the row volume is tiny — concurrent edits are not a concern for a
 * single-operator app. If contention ever shows up we'll move to an RPC.
 *
 * The merge is shallow: passing `image_payload: {...}` replaces the whole
 * image_payload object. Passing `image_payload: null` deletes the key so the
 * UI can clear a track when the operator flips format=image → format=video.
 */
function mergeDraft(existing: unknown, patch: Record<string, unknown>): Record<string, unknown> {
  const base: Record<string, unknown> =
    existing && typeof existing === "object" && !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>) }
      : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete base[key];
    } else if (value !== undefined) {
      base[key] = value;
    }
  }
  return base;
}

/**
 * PATCH /api/pipelines/:id/config
 *
 * Merges the supplied fields into `pipelines.config_draft`. Used by the
 * StageConfiguration form's 1s-debounced autosave. The client may also PATCH
 * `format_choice` here — useful when an Ekko draft proposes a different
 * format from what the operator started with — and we forward that change to
 * the top-level `pipelines.format_choice` column too.
 *
 * Status guard:
 *   The route refuses (409 `config_locked`) if the pipeline has already moved
 *   past `configuration`. Letting an autosave bleed into a later stage would
 *   silently corrupt the draft after the brief rows have been inserted.
 *
 * Returns:
 *   200 `{ pipeline, config_draft }` — the merged draft and the post-update row.
 *   400 — invalid JSON body or schema validation failure.
 *   404 — pipeline does not exist.
 *   409 `{ error: 'config locked', current_status }` — out-of-stage PATCH.
 *   500 — DB error.
 */
export async function PATCH(req: NextRequest, ctx: RouteContext) {
  const { id } = await ctx.params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = ConfigPatchBody.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation_failed", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const supabase = createAdminClient();

  // Read once to check status + merge against the existing draft. We pay the
  // extra round-trip rather than blind-writing because the status guard is
  // load-bearing — if the pipeline already advanced, we don't want the autosave
  // to clobber the post-advance state.
  const { data: existing, error: readErr } = await supabase
    .from("pipelines")
    .select("id, status, config_draft, format_choice")
    .eq("id", id)
    .maybeSingle();
  if (readErr) {
    return NextResponse.json({ error: readErr.message }, { status: 500 });
  }
  if (!existing) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  if (existing.status !== "configuration") {
    return NextResponse.json(
      { error: "config locked", current_status: existing.status },
      { status: 409 },
    );
  }

  // Build the draft patch — we deliberately do NOT include `format_choice` /
  // `client_id` in the draft jsonb. `format_choice` lives on a top-level
  // column (and is mirrored to `config_draft.format_choice` for the form's
  // hydration convenience); `client_id` is a top-level FK too.
  const data = parsed.data;
  const draftPatch: Record<string, unknown> = {};
  if (data.image_payload !== undefined) draftPatch.image_payload = data.image_payload;
  if (data.video_payload !== undefined) draftPatch.video_payload = data.video_payload;
  if (data.notes !== undefined) draftPatch.notes = data.notes;
  if (data.format_choice !== undefined) draftPatch.format_choice = data.format_choice;

  const mergedDraft = mergeDraft(existing.config_draft, draftPatch);

  const update: {
    config_draft: Json;
    format_choice?: "image" | "video" | "both";
    client_id?: string | null;
  } = {
    config_draft: mergedDraft as unknown as Json,
  };
  if (data.format_choice !== undefined) update.format_choice = data.format_choice;
  if (data.client_id !== undefined) update.client_id = data.client_id;

  const { data: updated, error: updateErr } = await supabase
    .from("pipelines")
    .update(update)
    .eq("id", id)
    // Re-assert the status guard at the DB level so a concurrent advance
    // doesn't race past our pre-read check (single-operator v1, but cheap
    // belt-and-suspenders).
    .eq("status", "configuration")
    .select()
    .single();
  if (updateErr || !updated) {
    return NextResponse.json({ error: updateErr?.message ?? "update failed" }, { status: 500 });
  }

  return NextResponse.json({ pipeline: updated, config_draft: mergedDraft });
}
