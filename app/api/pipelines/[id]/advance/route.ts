import { NextResponse, type NextRequest } from "next/server";

import { BriefPayload, type BriefInsert } from "@/lib/briefs";
import { dispatchOperator, isOperatorDriven, operatorInstruction } from "@/lib/operator/dispatch";
import { activeTracksLocal, canAdvance } from "@/lib/pipeline/transitions";
import type { PipelineEventInsert, PipelineUpdate } from "@/lib/pipeline/schemas";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Database, Json } from "@/lib/supabase/types.gen";
import { VideoBriefInput, type VideoBriefInsertRow } from "@/lib/video-briefs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

type SupabaseClient = ReturnType<typeof createAdminClient>;

/**
 * POST /api/pipelines/:id/advance
 *
 * State-machine handler. Looks at the pipeline's current status and runs the
 * right transition. The body is empty — the route derives everything from the
 * stored `config_draft` / `picks` / `approval` jsonb columns.
 *
 * Currently implemented:
 *
 *   configuration → ideation
 *     - Validates `config_draft` payloads against the canonical brief
 *       schemas (BriefPayload / VideoBriefInput).
 *     - Inserts a `briefs` row (image track active) and/or a `video_briefs`
 *       row (video track active). Both rows land as `posted` so the existing
 *       approval surface can pick them up if anyone hits the standalone
 *       brief page; the pipeline still owns the operational state.
 *     - Updates the pipeline: status → ideation, image_brief_id /
 *       video_brief_id set, `advanced_at.ideation` stamped.
 *     - Emits `pipeline_events(kind='stage_advanced', stage='ideation')`.
 *     - Fires-and-forgets a POST to the worker's ideation endpoint. The
 *       worker route doesn't exist yet (Wave 11); we wrap the call in a
 *       try/catch so a connection refusal doesn't block the advance.
 *
 *   ideation → review
 *     - Gate: `pipelines.picks` must contain ≥1 uuid for each active
 *       track (image, video, or both depending on `format_choice`).
 *     - Updates the pipeline: status → review, `advanced_at.review`
 *       stamped.
 *     - Emits `pipeline_events(kind='stage_advanced', stage='review')`.
 *     - Insufficient picks return 422 with a field-level "picks" error so
 *       the UI can surface which track is unmet.
 *
 * Other transitions return 422 with a structured error — the matching
 * milestones (PF-D through PF-F) will fill those branches in.
 *
 * Atomicity: Supabase doesn't expose multi-table transactions through the
 * JS client. We insert briefs first, then the pipeline update, then the
 * event. If the pipeline update fails we attempt a compensating delete of
 * the freshly-inserted brief rows so we don't leave orphaned `posted`
 * briefs in the table.
 */
export async function POST(_req: NextRequest, ctx: RouteContext) {
  const { id } = await ctx.params;
  const supabase = createAdminClient();

  const { data: pipeline, error: readErr } = await supabase
    .from("pipelines")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (readErr) {
    return NextResponse.json({ error: readErr.message }, { status: 500 });
  }
  if (!pipeline) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  if (pipeline.status === "configuration") {
    return advanceFromConfiguration(supabase, pipeline);
  }
  if (pipeline.status === "ideation") {
    return advanceFromIdeation(supabase, pipeline);
  }

  // Every other status is a stage gate we haven't wired up yet.
  return NextResponse.json(
    {
      error: "transition not yet supported",
      from: pipeline.status,
    },
    { status: 422 },
  );
}

/**
 * Handle the `configuration → ideation` transition. Lives in a separate
 * function purely for readability — POST stays a thin dispatch.
 */
async function advanceFromConfiguration(
  supabase: SupabaseClient,
  pipeline: Database["public"]["Tables"]["pipelines"]["Row"],
): Promise<NextResponse> {
  // 1. Gate: do we have the required payloads at all?
  const gate = canAdvance({
    status: pipeline.status,
    format_choice: pipeline.format_choice,
    config_draft: pipeline.config_draft as Record<string, unknown> | null,
  });
  if (!gate.ok) {
    return NextResponse.json({ error: gate.reason, missing: gate.missing ?? [] }, { status: 422 });
  }

  // 1b. Operator-driven pipelines: the Hermes operator already authored the
  //     brief (the worker validated it; pipeline.image_brief_id is set) and it
  //     re-reads live state on each dispatch. Skip the deterministic
  //     validate-and-insert path below — running it would re-check the
  //     operator's looser, extras-bearing payload against the strict form
  //     schema (the "image_payload invalid" 422 the manager hit) and mint a
  //     duplicate brief. Just advance the stage and re-task the operator to
  //     author the concept previews (its render call is the spend gate).
  if (isOperatorDriven(pipeline.config_draft)) {
    const nowOp = new Date().toISOString();
    const prevAdvancedAt =
      pipeline.advanced_at &&
      typeof pipeline.advanced_at === "object" &&
      !Array.isArray(pipeline.advanced_at)
        ? (pipeline.advanced_at as Record<string, string>)
        : {};
    const opUpdate: PipelineUpdate = {
      status: "ideation",
      advanced_at: { ...prevAdvancedAt, ideation: nowOp } as unknown as Json,
    };
    const { data: opUpdated, error: opErr } = await supabase
      .from("pipelines")
      .update(opUpdate)
      .eq("id", pipeline.id)
      .eq("status", "configuration")
      .select()
      .single();
    if (opErr || !opUpdated) {
      return NextResponse.json(
        { error: opErr?.message ?? "pipeline advance failed" },
        { status: 500 },
      );
    }
    const opEvent: PipelineEventInsert = {
      pipeline_id: pipeline.id,
      kind: "stage_advanced",
      stage: "ideation",
      payload: { image_brief_id: pipeline.image_brief_id } as Json,
    };
    const { error: opEvErr } = await supabase.from("pipeline_events").insert(opEvent);
    if (opEvErr) {
      console.warn(`[pipelines.advance] event insert failed: ${opEvErr.message}`);
    }
    void retaskOperator(supabase, pipeline.id, "ideation", "config_approved");
    return NextResponse.json({
      pipeline: opUpdated,
      image_brief_id: pipeline.image_brief_id,
      video_brief_id: pipeline.video_brief_id,
    });
  }

  // 2. Pull the typed brief payloads out of the draft. zod-parse them now —
  //    the autosave route accepts loose shapes (so the operator can save
  //    incomplete drafts mid-form), but the advance gate is the spot where
  //    we require a fully-valid brief.
  const draft = (pipeline.config_draft ?? {}) as Record<string, unknown>;
  const tracks = activeTracksLocal(pipeline.format_choice);

  let imagePayload: ReturnType<typeof BriefPayload.safeParse> | null = null;
  let videoPayload: ReturnType<typeof VideoBriefInput.safeParse> | null = null;

  if (tracks.image) {
    imagePayload = BriefPayload.safeParse(draft.image_payload);
    if (!imagePayload.success) {
      return NextResponse.json(
        {
          error: "image_payload invalid",
          issues: imagePayload.error.issues,
        },
        { status: 422 },
      );
    }
  }
  if (tracks.video) {
    // The video brief schema demands `client_id` on its top-level shape; the
    // pipeline carries the canonical client_id, so we splice it in.
    const videoDraft = {
      ...(draft.video_payload as Record<string, unknown> | null | undefined),
      client_id: pipeline.client_id,
    };
    videoPayload = VideoBriefInput.safeParse(videoDraft);
    if (!videoPayload.success) {
      return NextResponse.json(
        {
          error: "video_payload invalid",
          issues: videoPayload.error.issues,
        },
        { status: 422 },
      );
    }
  }

  // 3. We need a client_id to mint the human IDs. The pipeline row carries
  //    one (set at create or autosave time); if it's missing we can't proceed.
  if (!pipeline.client_id) {
    return NextResponse.json(
      { error: "client_id missing — assign a client before advancing" },
      { status: 422 },
    );
  }
  const { data: client, error: clientErr } = await supabase
    .from("clients")
    .select("slug")
    .eq("id", pipeline.client_id)
    .maybeSingle();
  if (clientErr) {
    return NextResponse.json({ error: clientErr.message }, { status: 500 });
  }
  if (!client) {
    return NextResponse.json(
      { error: "client_not_found", client_id: pipeline.client_id },
      { status: 422 },
    );
  }

  // 4. Insert briefs. We post directly (status=posted) so the existing
  //    approval surface is consistent — the pipeline operator has already
  //    reviewed the form. `posted_at` mirrors the standalone /api/briefs
  //    route's behaviour.
  const now = new Date().toISOString();
  let imageBriefId: string | null = null;
  let videoBriefId: string | null = null;

  if (imagePayload?.success) {
    const { data: humanId, error: rpcErr } = await supabase.rpc("gen_brief_id_human", {
      p_client_slug: client.slug,
    });
    if (rpcErr || !humanId) {
      return NextResponse.json(
        { error: rpcErr?.message ?? "mint brief_id_human failed" },
        { status: 500 },
      );
    }
    const insert: BriefInsert = {
      brief_id_human: humanId,
      client_id: pipeline.client_id,
      payload: imagePayload.data as unknown as Json,
      status: "posted",
      posted_at: now,
    };
    const { data: brief, error: insertErr } = await supabase
      .from("briefs")
      .insert(insert)
      .select("id")
      .single();
    if (insertErr || !brief) {
      return NextResponse.json(
        { error: insertErr?.message ?? "image brief insert failed" },
        { status: 500 },
      );
    }
    imageBriefId = brief.id;
  }

  if (videoPayload?.success) {
    const { data: humanId, error: rpcErr } = await supabase.rpc(
      // RPC name lives outside the generated types; cast through unknown.
      "gen_video_brief_id_human" as never,
      { p_client_slug: client.slug } as never,
    );
    if (rpcErr || typeof humanId !== "string") {
      // Compensating: delete the image brief we just inserted (if any) so
      // we don't leave a dangling `posted` row.
      if (imageBriefId) {
        await supabase.from("briefs").delete().eq("id", imageBriefId);
      }
      return NextResponse.json(
        { error: rpcErr?.message ?? "mint video brief_id_human failed" },
        { status: 500 },
      );
    }
    const v = videoPayload.data;
    const insert: VideoBriefInsertRow = {
      brief_id_human: humanId,
      client_id: pipeline.client_id,
      status: "posted",
      script_outline: v.script_outline,
      target_duration_s: v.target_duration_s,
      voice_id: v.voice_id,
      music_track: v.music_track ?? null,
      hook_style: v.hook_style ?? null,
      dimensions: v.dimensions,
      captions_style: v.captions_style ?? null,
      broll_selection_mode: v.broll_selection_mode,
      payload: {
        notes: v.notes ?? null,
        ...(v.payload ?? {}),
      },
      posted_at: now,
    };
    const { data: brief, error: insertErr } = await supabase
      .from("video_briefs")
      .insert(insert)
      .select("id")
      .single();
    if (insertErr || !brief) {
      if (imageBriefId) {
        await supabase.from("briefs").delete().eq("id", imageBriefId);
      }
      return NextResponse.json(
        { error: insertErr?.message ?? "video brief insert failed" },
        { status: 500 },
      );
    }
    videoBriefId = brief.id;
  }

  // 5. Update the pipeline row. Re-assert status=configuration so a
  //    concurrent second advance can't double-promote.
  const advancedAt =
    (pipeline.advanced_at &&
    typeof pipeline.advanced_at === "object" &&
    !Array.isArray(pipeline.advanced_at)
      ? (pipeline.advanced_at as Record<string, string>)
      : {}) ?? {};
  const nextAdvancedAt = { ...advancedAt, ideation: now };
  const update: PipelineUpdate = {
    status: "ideation",
    image_brief_id: imageBriefId,
    video_brief_id: videoBriefId,
    advanced_at: nextAdvancedAt as unknown as Json,
  };
  const { data: updated, error: updateErr } = await supabase
    .from("pipelines")
    .update(update)
    .eq("id", pipeline.id)
    .eq("status", "configuration")
    .select()
    .single();
  if (updateErr || !updated) {
    // Compensating cleanup — both possible briefs.
    if (imageBriefId) {
      await supabase.from("briefs").delete().eq("id", imageBriefId);
    }
    if (videoBriefId) {
      await supabase.from("video_briefs").delete().eq("id", videoBriefId);
    }
    return NextResponse.json(
      { error: updateErr?.message ?? "pipeline advance failed" },
      { status: 500 },
    );
  }

  // 6. Emit the timeline event. Failure is non-fatal — the row is the
  //    primary artifact and the dashboard re-derives state from the row.
  const event: PipelineEventInsert = {
    pipeline_id: pipeline.id,
    kind: "stage_advanced",
    stage: "ideation",
    payload: {
      image_brief_id: imageBriefId,
      video_brief_id: videoBriefId,
    } as Json,
  };
  const { error: evErr } = await supabase.from("pipeline_events").insert(event);
  if (evErr) {
    console.warn(`[pipelines.advance] event insert failed: ${evErr.message}`);
  }

  // 7. Hand ideation off to the right executor — exactly one of them, never
  //    both (running both would render every concept twice and double the Kie
  //    spend). Operator-driven pipelines: the Hermes operator authors + renders
  //    the concept previews (its render call is the spend gate). Regular
  //    pipelines: the deterministic /work/pipeline/ideation producer (Ekko's
  //    image-ad-prompting skill is an interactive prompt-writer, not an
  //    automated executor). Both paths emit the same task_* / cost_recorded
  //    pipeline_events the StageGeneration UI + auto-advance trigger read, and
  //    both are fire-and-forget so a worker outage never blocks the advance.
  if (isOperatorDriven(pipeline.config_draft)) {
    void retaskOperator(supabase, pipeline.id, "ideation", "config_approved");
  } else {
    void fireWorkerIdeation(pipeline.id).catch((e) => {
      console.warn(
        `[pipelines.advance] worker ideation kick failed for ${pipeline.id}: ${String(e)}`,
      );
    });
  }

  return NextResponse.json({
    pipeline: updated,
    image_brief_id: imageBriefId,
    video_brief_id: videoBriefId,
  });
}

/**
 * Handle the `ideation → review` transition. The gate is purely a read of
 * `pipelines.picks`: every active track must have ≥1 uuid recorded.
 *
 * We don't re-validate the uuids here — the `/picks` route already enforced
 * that they belong to this pipeline's brief at write time. Re-checking on
 * advance would be a courtesy at best and would couple this route to the
 * creatives tables for no operational benefit.
 */
async function advanceFromIdeation(
  supabase: SupabaseClient,
  pipeline: Database["public"]["Tables"]["pipelines"]["Row"],
): Promise<NextResponse> {
  // 1. Read the per-track pick arrays from the jsonb column. Defensive
  //    parse — the column defaults to `{}` and an older row might have
  //    odd-shaped data.
  const picks = readPicksJsonb(pipeline.picks);
  const tracks = activeTracksLocal(pipeline.format_choice);

  const missing: string[] = [];
  if (tracks.image && (picks.image?.length ?? 0) < 1) {
    missing.push("image");
  }
  if (tracks.video && (picks.video?.length ?? 0) < 1) {
    missing.push("video");
  }
  if (missing.length > 0) {
    return NextResponse.json(
      {
        error: "insufficient picks",
        field: "picks",
        missing,
        reason: `each active track needs ≥1 pick (missing: ${missing.join(", ")})`,
      },
      { status: 422 },
    );
  }

  // 2. Stamp the advance timestamp and update the row. Re-assert
  //    status=ideation so a concurrent second advance can't double-promote.
  const now = new Date().toISOString();
  const advancedAt =
    (pipeline.advanced_at &&
    typeof pipeline.advanced_at === "object" &&
    !Array.isArray(pipeline.advanced_at)
      ? (pipeline.advanced_at as Record<string, string>)
      : {}) ?? {};
  const nextAdvancedAt = { ...advancedAt, review: now };
  const update: PipelineUpdate = {
    status: "review",
    advanced_at: nextAdvancedAt as unknown as Json,
  };
  const { data: updated, error: updateErr } = await supabase
    .from("pipelines")
    .update(update)
    .eq("id", pipeline.id)
    .eq("status", "ideation")
    .select()
    .single();
  if (updateErr || !updated) {
    return NextResponse.json(
      { error: updateErr?.message ?? "pipeline advance failed" },
      { status: 500 },
    );
  }

  // 3. Emit the timeline event. Failure is non-fatal.
  const event: PipelineEventInsert = {
    pipeline_id: pipeline.id,
    kind: "stage_advanced",
    stage: "review",
    payload: {
      image_picks: picks.image?.length ?? 0,
      video_picks: picks.video?.length ?? 0,
    } as Json,
  };
  const { error: evErr } = await supabase.from("pipeline_events").insert(event);
  if (evErr) {
    console.warn(`[pipelines.advance] event insert failed: ${evErr.message}`);
  }

  return NextResponse.json({ pipeline: updated });
}

/**
 * Read the `pipelines.picks` jsonb into a typed shape, dropping anything
 * that doesn't look like the agreed `{ image?: string[], video?: string[] }`
 * contract. Older rows / hand-edited columns degrade gracefully.
 */
function readPicksJsonb(value: unknown): { image?: string[]; video?: string[] } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const obj = value as Record<string, unknown>;
  const out: { image?: string[]; video?: string[] } = {};
  if (Array.isArray(obj.image)) {
    out.image = obj.image.filter((v): v is string => typeof v === "string");
  }
  if (Array.isArray(obj.video)) {
    out.video = obj.video.filter((v): v is string => typeof v === "string");
  }
  return out;
}

/**
 * Re-task the operator for the next stage and record the handoff on the
 * timeline. Both halves are best-effort:
 *
 *   - the `operator_dispatched` event makes the narration view show the
 *     handoff immediately (before the operator's own events stream in);
 *   - the worker dispatch nudges the operator container.
 *
 * Idempotency lives on the operator side — it reads the live pipeline state
 * and only does the work that's outstanding for the stage — so a duplicate
 * dispatch (e.g. a double-clicked Continue) is safe. We swallow every failure
 * here: a stage transition has already committed and must not be undone by a
 * worker outage.
 */
async function retaskOperator(
  supabase: SupabaseClient,
  pipelineId: string,
  stage: "ideation" | "generation",
  reason: string,
): Promise<void> {
  const instruction = operatorInstruction(stage, pipelineId);
  const event: PipelineEventInsert = {
    pipeline_id: pipelineId,
    kind: "operator_dispatched",
    stage,
    payload: { instruction, reason } as Json,
  };
  const { error: evErr } = await supabase.from("pipeline_events").insert(event);
  if (evErr) {
    console.warn(`[pipelines.advance] operator_dispatched event insert failed: ${evErr.message}`);
  }
  try {
    await dispatchOperator(pipelineId, instruction);
  } catch (e) {
    console.warn(`[pipelines.advance] operator dispatch failed for ${pipelineId}: ${String(e)}`);
  }
}

/**
 * Fire-and-forget POST to the worker's image-generation ideation endpoint
 * (`/work/pipeline/ideation`). Wrapped in its own function so the call site
 * can `void fireWorkerIdeation(...).catch(...)` cleanly without leaking the
 * promise chain into the response path.
 *
 * The worker reads everything it needs (briefs, picks, format) from the
 * pipeline row keyed by `pipeline_id`, so the body is just the id. Skip when
 * WORKER_URL or WORKER_SHARED_SECRET are unset — the API route still
 * succeeds and unit tests don't need to stub the worker. A 404 is treated
 * as "worker not configured / route not deployed" and swallowed silently;
 * anything else is logged.
 */
async function fireWorkerIdeation(pipelineId: string): Promise<void> {
  const base = process.env.WORKER_URL?.replace(/\/$/, "");
  const secret = process.env.WORKER_SHARED_SECRET;
  if (!base || !secret) return;
  const res = await fetch(`${base}/work/pipeline/ideation`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secret}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ pipeline_id: pipelineId }),
    cache: "no-store",
  });
  if (!res.ok && res.status !== 404) {
    const text = await res.text().catch(() => "");
    throw new Error(`worker /work/pipeline/ideation -> ${res.status}: ${text.slice(0, 200)}`);
  }
}
