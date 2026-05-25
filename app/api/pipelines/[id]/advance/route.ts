import { NextResponse, type NextRequest } from "next/server";

import { BriefPayload, type BriefInsert } from "@/lib/briefs";
import { dispatchOperator, isOperatorDriven, operatorInstruction } from "@/lib/operator/dispatch";
import {
  PER_CREATIVE_STAGES,
  activeTracksLocal,
  canAdvance,
  nextStage,
} from "@/lib/pipeline/transitions";
import type { PipelineFormat } from "@/lib/pipeline/types";
import {
  copyGateCleared,
  isCreativeInScope,
  rollupCleared as rollupClearedCore,
} from "@/lib/pipeline/rollup";
import type { PipelineEventInsert, PipelineUpdate } from "@/lib/pipeline/schemas";
import type { PipelineStatus } from "@/lib/pipeline/types";
import { MIN_APPROVED_COPY } from "@/lib/review/grid";
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
  // Per-creative gated stages (creative_qa, compliance_review, copy,
  // spec_validation): the server re-computes the per-creative rollup from
  // creative_stage_state and HARD-BLOCKS the advance until the gate clears.
  // Compliance is the HARD gate — it (and launch) never auto-advance: a failed
  // creative without an audited override keeps the rollup uncleared, so this
  // route refuses with 422.
  if (PER_CREATIVE_STAGES.has(pipeline.status as PipelineStatus)) {
    return advanceFromPerCreativeStage(supabase, pipeline);
  }
  // finalize_assets → launch_handoff: an AGENT_WORK/AUTO stage with no DB
  // trigger (only generation→creative_qa is trigger-driven, see 0024). Without
  // a wired transition the pipeline STALLS at finalize_assets — the UI falls
  // through to a placeholder and nothing advances it. The gate is "every
  // in-scope creative is finalize_verified" (the operator's finalize_result /
  // finalize_drive tools stamp it), re-derived server-side here.
  if (pipeline.status === "finalize_assets") {
    return advanceFromFinalizeAssets(supabase, pipeline);
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
 * Handle the `finalize_assets → launch_handoff` transition. finalize_assets is
 * an AGENT_WORK stage closed by the operator's finalize tools; there is no DB
 * trigger for it (0024 only auto-advances generation→creative_qa), so the route
 * is the execution path that keeps the chain from stalling here.
 *
 * Gate (re-derived server-side, never trusting the client): at least one
 * in-scope (non-deleted) creative for the pipeline AND every one of them is
 * `finalize_verified = true`. That mirrors the work-unit closure spirit
 * ("≥1 done, none outstanding") against the creatives the finalize tools stamp.
 */
async function advanceFromFinalizeAssets(
  supabase: SupabaseClient,
  pipeline: Database["public"]["Tables"]["pipelines"]["Row"],
): Promise<NextResponse> {
  const tracks = activeTracksLocal(pipeline.format_choice as PipelineFormat);

  const creatives: Array<{ id: string; finalize_verified: boolean | null }> = [];

  // Image track: the in-scope (non-deleted) image creatives the finalize tools
  // stamp. Read only when the image track is active so an image-only pipeline's
  // query plan is byte-identical to before and a video-only pipeline doesn't
  // run a no-op image read.
  if (tracks.image) {
    const { data: rows, error: readErr } = await supabase
      .from("creatives")
      .select("id, finalize_verified")
      .eq("pipeline_id", pipeline.id)
      .is("deleted_at", null);
    if (readErr) {
      return NextResponse.json({ error: readErr.message }, { status: 500 });
    }
    for (const r of (rows ?? []) as Array<{ id: string; finalize_verified: boolean | null }>) {
      creatives.push(r);
    }
  }

  // Video track: count the pipeline's in-scope video creatives' finalize state
  // too (the operator's video finalize tools stamp video_creatives.finalize_verified,
  // migration 0031). Video creatives join the pipeline via the pipeline's
  // video_brief_id. Additive: image semantics are untouched.
  if (tracks.video && pipeline.video_brief_id) {
    const { data: vRows, error: vErr } = await supabase
      .from("video_creatives")
      .select("id, finalize_verified")
      .eq("brief_id", pipeline.video_brief_id)
      .is("deleted_at", null);
    if (vErr) {
      return NextResponse.json({ error: vErr.message }, { status: 500 });
    }
    for (const r of (vRows ?? []) as Array<{ id: string; finalize_verified: boolean | null }>) {
      creatives.push(r);
    }
  }

  const total = creatives.length;
  const unverified = creatives.filter((c) => c.finalize_verified !== true).length;
  if (total === 0 || unverified > 0) {
    return NextResponse.json(
      {
        error: "finalize not complete: every creative must be finalize_verified",
        field: "finalize",
        stage: "finalize_assets",
        finalize: { total, unverified },
      },
      { status: 422 },
    );
  }

  const now = new Date().toISOString();
  const advancedAt =
    pipeline.advanced_at &&
    typeof pipeline.advanced_at === "object" &&
    !Array.isArray(pipeline.advanced_at)
      ? (pipeline.advanced_at as Record<string, string>)
      : {};
  const update: PipelineUpdate = {
    status: "launch_handoff",
    advanced_at: { ...advancedAt, launch_handoff: now } as unknown as Json,
  };
  const { data: updated, error: updateErr } = await supabase
    .from("pipelines")
    .update(update)
    .eq("id", pipeline.id)
    .eq("status", "finalize_assets")
    .select()
    .single();
  if (updateErr || !updated) {
    return NextResponse.json(
      { error: updateErr?.message ?? "finalize advance failed" },
      { status: 500 },
    );
  }

  const event: PipelineEventInsert = {
    pipeline_id: pipeline.id,
    kind: "stage_advanced",
    stage: "launch_handoff",
    payload: { from: "finalize_assets", finalized: total } as Json,
  };
  const { error: evErr } = await supabase.from("pipeline_events").insert(event);
  if (evErr) {
    console.warn(`[pipelines.advance] event insert failed: ${evErr.message}`);
  }

  return NextResponse.json({ pipeline: updated });
}

/**
 * Compute the per-creative rollup for `(pipeline, stage)` exactly as the DB
 * `pipeline_rollup_cleared()` function does (migration 0039, the single source):
 * cleared iff ≥1 IN-SCOPE row exists AND every such row is terminal-good
 * (`passed | overridden | skipped`). A killed (or soft-deleted) creative drops
 * out of the scope so it can never hold the gate — the E2.3 killed-creative drift
 * fix that aligns this route with `lib/review/grid.ts` AND the SQL predicate. The
 * cleared-state set + the in-scope rule + the rollup verdict are read from the
 * one `lib/pipeline/rollup.ts` module (mirrored by the SQL, parity-tested), never
 * re-derived here.
 *
 * Returns `{ cleared, total, blocking }` so the 422 body can name what is still
 * holding the gate. A read error is surfaced (caller turns it into a 500).
 */
async function computeRollup(
  supabase: SupabaseClient,
  pipelineId: string,
  stage: PipelineStatus,
): Promise<
  { ok: true; cleared: boolean; total: number; blocking: number } | { ok: false; message: string }
> {
  const { data, error } = await supabase
    .from("creative_stage_state")
    .select("status, creative_id")
    .eq("pipeline_id", pipelineId)
    .eq("stage", stage as Database["public"]["Enums"]["creative_stage_enum"]);
  if (error) {
    return { ok: false, message: error.message };
  }
  const rows = (data ?? []) as Array<{
    status: Database["public"]["Enums"]["stage_state_enum"];
    creative_id?: string | null;
  }>;

  // Drop killed creatives from the scope (parity with the grid + the SQL). We
  // only look up the killed set — there is no per-creative status on the gate
  // row itself, and a row whose creative is killed must not hold the gate.
  const killed = await killedCreativeIds(supabase, pipelineId);
  const inScope = rows.filter((r) => !(r.creative_id && killed.has(r.creative_id)));

  const { cleared, total, blocking } = rollupClearedCore(inScope.map((r) => r.status));
  return { ok: true, cleared, total, blocking };
}

/**
 * The set of image-creative ids killed for a pipeline — the rows the rollup +
 * copy gates drop from scope (a killed creative never holds a gate). Only image
 * creatives can be `killed` (video_creative_status has no such value), so this
 * reads `creatives`. A read error surfaces an empty set rather than failing the
 * advance: excluding fewer creatives only ever makes the gate STRICTER, never
 * looser, so a transient read miss can never let an unqualified pipeline through.
 */
async function killedCreativeIds(
  supabase: SupabaseClient,
  pipelineId: string,
): Promise<Set<string>> {
  const { data, error } = await supabase
    .from("creatives")
    .select("id")
    .eq("pipeline_id", pipelineId)
    .eq("status", "killed");
  if (error || !data) {
    return new Set<string>();
  }
  return new Set((data as Array<{ id: string }>).map((c) => c.id));
}

/**
 * Handle the four per-creative gated stages
 * (`creative_qa → compliance_review → copy → spec_validation`). The server
 * recomputes the rollup from `creative_stage_state` and feeds it to
 * `canAdvance(pipeline, { rollupCleared })`. When the gate predicate fails the
 * advance is refused with 422 — this is the hard block. Compliance is special
 * only in its 422 message; the enforcement (a `failed` creative leaves the
 * rollup uncleared) is identical for every per-creative stage.
 */
async function advanceFromPerCreativeStage(
  supabase: SupabaseClient,
  pipeline: Database["public"]["Tables"]["pipelines"]["Row"],
): Promise<NextResponse> {
  const status = pipeline.status as PipelineStatus;

  // The `copy` stage's gate is "≥3 approved copy variants per in-scope
  // creative" — the SAME predicate the StageCopy UI enables Continue on and the
  // launch precondition `copy_ge_3` re-checks. The operator copy tool only ever
  // rolls creative_stage_state(copy) to `in_progress` (never a cleared state),
  // so gating copy on that rollup would STALL the stage permanently. Re-derive
  // the approved-copy gate here instead so the UI and the server agree.
  if (status === "copy") {
    const copyGate = await computeCopyGate(supabase, pipeline);
    if (!copyGate.ok) {
      return NextResponse.json({ error: copyGate.message }, { status: 500 });
    }
    if (!copyGate.cleared) {
      return NextResponse.json(
        {
          error: `copy not cleared: every creative needs >=${MIN_APPROVED_COPY} approved variants`,
          field: "copy",
          stage: status,
          copy: { total: copyGate.total, short: copyGate.short },
        },
        { status: 422 },
      );
    }
    return commitPerCreativeAdvance(supabase, pipeline, status, true);
  }

  const rollup = await computeRollup(supabase, pipeline.id, status);
  if (!rollup.ok) {
    return NextResponse.json({ error: rollup.message }, { status: 500 });
  }

  const gate = canAdvance(
    {
      status,
      format_choice: pipeline.format_choice,
      config_draft: pipeline.config_draft as Record<string, unknown> | null,
    },
    { rollupCleared: rollup.cleared },
  );
  if (!gate.ok) {
    return NextResponse.json(
      {
        error: gate.reason,
        field: "rollup",
        stage: status,
        rollup: { total: rollup.total, blocking: rollup.blocking },
      },
      { status: 422 },
    );
  }
  return commitPerCreativeAdvance(supabase, pipeline, status, rollup.cleared);
}

/**
 * Re-derive the copy gate: ≥{@link MIN_APPROVED_COPY} approved copy variants per
 * in-scope (non-killed, non-deleted) creative, counting BOTH tracks for a
 * format=both / video pipeline:
 *   - image creatives' approved `copy_variants`,
 *   - video creatives' approved `video_copy_variants` (parity tables from
 *     migration 0031; the video copy tool upserts them per creative/platform).
 *
 * Each track's tables are read only when that track is active, so an image-only
 * pipeline's behaviour (and query plan) is byte-identical to before; a video or
 * both pipeline additionally folds its video creatives into the same
 * ≥MIN_APPROVED_COPY-per-in-scope-creative predicate. Image creatives may be
 * `killed` (dropped from scope); video creatives are in scope unless soft-deleted
 * (video_creative_status has no `killed` value). Returns `{ cleared, total, short }`
 * so a 422 can name how many creatives are short on approved copy. A read error
 * surfaces (caller turns it into a 500).
 */
async function computeCopyGate(
  supabase: SupabaseClient,
  pipeline: Database["public"]["Tables"]["pipelines"]["Row"],
): Promise<
  { ok: true; cleared: boolean; total: number; short: number } | { ok: false; message: string }
> {
  const pipelineId = pipeline.id;
  const tracks = activeTracksLocal(pipeline.format_choice as PipelineFormat);

  const inScopeIds: string[] = [];
  const approvedByCreative = new Map<string, number>();

  // Image track (unchanged): in-scope image creatives + their approved copy.
  if (tracks.image) {
    const { data: creatives, error: cErr } = await supabase
      .from("creatives")
      .select("id, status")
      .eq("pipeline_id", pipelineId)
      .is("deleted_at", null);
    if (cErr) {
      return { ok: false, message: cErr.message };
    }
    for (const c of (creatives ?? []).filter((c) =>
      isCreativeInScope(c as { status?: string | null }),
    ) as Array<{ id: string }>) {
      inScopeIds.push(c.id);
    }

    const { data: variants, error: vErr } = await supabase
      .from("copy_variants")
      .select("creative_id, status")
      .eq("pipeline_id", pipelineId)
      .eq("status", "approved");
    if (vErr) {
      return { ok: false, message: vErr.message };
    }
    for (const v of (variants ?? []) as Array<{ creative_id: string }>) {
      approvedByCreative.set(v.creative_id, (approvedByCreative.get(v.creative_id) ?? 0) + 1);
    }
  }

  // Video track (additive): in-scope video creatives (joined via the pipeline's
  // video_brief_id) + their approved video_copy_variants.
  if (tracks.video && pipeline.video_brief_id) {
    const { data: vCreatives, error: vcErr } = await supabase
      .from("video_creatives")
      .select("id, status")
      .eq("brief_id", pipeline.video_brief_id)
      .is("deleted_at", null);
    if (vcErr) {
      return { ok: false, message: vcErr.message };
    }
    const videoIds = (vCreatives ?? []).map((c) => (c as { id: string }).id);
    for (const cid of videoIds) {
      inScopeIds.push(cid);
    }

    if (videoIds.length > 0) {
      const { data: vVariants, error: vvErr } = await supabase
        .from("video_copy_variants")
        .select("creative_id, status")
        .in("creative_id", videoIds)
        .eq("status", "approved");
      if (vvErr) {
        return { ok: false, message: vvErr.message };
      }
      for (const v of (vVariants ?? []) as Array<{ creative_id: string }>) {
        approvedByCreative.set(v.creative_id, (approvedByCreative.get(v.creative_id) ?? 0) + 1);
      }
    }
  }

  // Single-source copy-gate predicate (≥MIN_APPROVED_COPY approved per in-scope
  // creative) — the same one the launch checklist + StageCopy UI read.
  const { cleared, total, short } = copyGateCleared(inScopeIds, approvedByCreative);
  return { ok: true, cleared, total, short };
}

/**
 * Commit a per-creative stage advance: compare-and-set the pipeline status to
 * its successor and emit the `stage_advanced` event. Shared by the rollup-gated
 * stages and the copy stage so both record the move identically.
 */
async function commitPerCreativeAdvance(
  supabase: SupabaseClient,
  pipeline: Database["public"]["Tables"]["pipelines"]["Row"],
  status: PipelineStatus,
  cleared: boolean,
): Promise<NextResponse> {
  const next = nextStage(status);
  if (!next) {
    // Unreachable for the per-creative stages (all have a successor), but keep
    // the type narrow and fail loudly rather than write a null status.
    return NextResponse.json({ error: `no successor stage for ${status}` }, { status: 422 });
  }

  const now = new Date().toISOString();
  const advancedAt =
    pipeline.advanced_at &&
    typeof pipeline.advanced_at === "object" &&
    !Array.isArray(pipeline.advanced_at)
      ? (pipeline.advanced_at as Record<string, string>)
      : {};
  const nextAdvancedAt = { ...advancedAt, [next]: now };
  const update: PipelineUpdate = {
    status: next,
    advanced_at: nextAdvancedAt as unknown as Json,
  };
  // Compare-and-set on the current status so a concurrent second advance (or a
  // stale double-click) can't double-promote.
  const { data: updated, error: updateErr } = await supabase
    .from("pipelines")
    .update(update)
    .eq("id", pipeline.id)
    .eq("status", status)
    .select()
    .single();
  if (updateErr || !updated) {
    return NextResponse.json(
      { error: updateErr?.message ?? "pipeline advance failed" },
      { status: 500 },
    );
  }

  const event: PipelineEventInsert = {
    pipeline_id: pipeline.id,
    kind: "stage_advanced",
    stage: next,
    payload: { from: status, rollup_cleared: cleared } as Json,
  };
  const { error: evErr } = await supabase.from("pipeline_events").insert(event);
  if (evErr) {
    console.warn(`[pipelines.advance] event insert failed: ${evErr.message}`);
  }

  return NextResponse.json({ pipeline: updated });
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
    const { data: humanId, error: rpcErr } = await supabase.rpc("gen_video_brief_id_human", {
      p_client_slug: client.slug,
    });
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
