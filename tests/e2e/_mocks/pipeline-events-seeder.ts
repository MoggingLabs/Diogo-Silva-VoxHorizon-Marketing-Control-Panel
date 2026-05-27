import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import type { Database, Json } from "@/lib/supabase/types.gen";

/**
 * Pipeline events + creatives seeder for the e2e SSE-mock harness.
 *
 * The Pipeline detail page reads its realtime feed off `pipeline_events`
 * and per-track grid state off `creatives` / `video_creatives`. In production
 * the worker drives those writes. For e2e we don't run the worker, so we
 * insert the rows directly via the service-role client; the UI's Supabase
 * Realtime subscriptions then deliver them to the page as if a worker
 * produced them.
 *
 * Two write surfaces matter:
 *
 *   1. `seedIdeationVariants` — inserts N rows into `creatives` (image) or
 *      `video_creatives` (video) plus matching `pipeline_events(kind=task_done,
 *      stage=ideation)` rows. Used after `configuration → ideation` to fill
 *      the StageIdeation grid so the operator can pick variants.
 *
 *   2. `seedGenerationTasks` — for each pick, emits the queued → running →
 *      done event chain plus inserts the finalized `creatives` /
 *      `video_creatives` rows that StageDone reads. The DB trigger
 *      `pipeline_events_auto_advance_done_trg` (migration 0007) sees the
 *      task_done events and flips the pipeline to `status='done'` itself,
 *      so we only need to seed the events — no manual status update.
 *
 * All writes use the service-role client to bypass RLS. The fixture's
 * `cleanupAll` sweeps everything afterwards via `cleanupCreatives` +
 * `cleanupPipelines` (both cascade through `pipeline_events`).
 */

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SECRET_KEY;

/**
 * Lazily-built admin client. Throws a friendly error if env is missing so
 * Playwright surfaces the cause instead of a deep SDK undefined deref.
 * Mirrors the pattern in `_fixtures.ts` / `_seed.ts` so all three modules
 * fail fast with the same error text.
 */
export function getAdminClient(): SupabaseClient<Database> {
  if (!supabaseUrl) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL is required for e2e tests — set it in .env.local before running pnpm test:e2e.",
    );
  }
  if (!serviceRoleKey) {
    throw new Error(
      "SUPABASE_SECRET_KEY is required for e2e tests — set it in .env.local before running pnpm test:e2e.",
    );
  }
  return createClient<Database>(supabaseUrl, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}

// ---------------------------------------------------------------------------
// Ideation seeders — drive the StageIdeation grid
// ---------------------------------------------------------------------------

export type SeededIdeationVariant = {
  id: string;
  concept: string;
};

/**
 * Insert N ideation-stage creatives + matching `pipeline_events` rows so the
 * StageIdeation grid has cards to render and the operator can pick them.
 *
 * Image variants:
 *   - One `creatives` row each, `version='v0.ideation'`, `ratio='1x1'`,
 *     `status='draft'`. `file_path_supabase` is left null so the card shows
 *     the "No render yet" placeholder — we don't have an actual image to
 *     upload to Storage, and the placeholder is sufficient to assert on.
 *
 * Video variants:
 *   - One `video_creatives` row each, `version=1`, `status='script_ready'`,
 *     with a stubbed `broll_clips` array carrying themes (so the card's
 *     "B-roll: ..." summary renders) and a `null` `script_path` (the
 *     excerpt fetch is best-effort; the placeholder copy is shown instead).
 *
 * Each variant insert is followed by a `pipeline_events` row mirroring the
 * shape the worker emits (`kind='task_done'`, `stage='ideation'`,
 * `payload.kind='image'|'video'`, `payload.concept`, `payload.creative_id`).
 *
 * Returns the inserted variant uuids in insert order so the spec can pick
 * the first N via the picks API.
 */
export async function seedIdeationVariants(
  pipelineId: string,
  briefId: string,
  kind: "image" | "video",
  n: number,
): Promise<SeededIdeationVariant[]> {
  const admin = getAdminClient();
  const variants: SeededIdeationVariant[] = [];

  for (let i = 0; i < n; i += 1) {
    const concept = `ideation-${i + 1}-mocked-${kind}-${randomSuffix()}`;

    if (kind === "image") {
      const { data: row, error } = await admin
        .from("creatives")
        .insert({
          brief_id: briefId,
          type: "image",
          status: "draft",
          ratio: "1x1",
          version: "v0.ideation",
          concept,
          // No file_path_supabase — the placeholder tile renders. This keeps
          // the seeder fast and decoupled from a storage upload.
          file_path_supabase: null,
          file_path_drive: null,
          prompt_used: {
            model: "kie/nano-banana-2",
            prompt: `Mocked ideation prompt ${i + 1}`,
            ratio: "1x1",
            stage: "ideation",
          } as unknown as Json,
        })
        .select("id")
        .single();
      if (error || !row) {
        throw new Error(
          `seedIdeationVariants (image #${i + 1}) failed: ${error?.message ?? "no row returned"}`,
        );
      }
      variants.push({ id: row.id, concept });

      // Mirror the worker's task_done emission so the timeline picks it up.
      const evErr = await admin.from("pipeline_events").insert({
        pipeline_id: pipelineId,
        kind: "task_done",
        stage: "ideation",
        payload: {
          kind: "image",
          concept,
          ratio: "1x1",
          creative_id: row.id,
        } as unknown as Json,
      });
      if (evErr.error) {
        throw new Error(`seedIdeationVariants (image event) failed: ${evErr.error.message}`);
      }
    } else {
      // Video — write a minimal `video_creatives` row in `script_ready` so
      // the StageIdeation card renders a status line + b-roll summary.
      const brollClips = [
        { idx: 0, theme: "trust", query: `${concept} b-roll`, duration_s: 10 },
        { idx: 1, theme: "savings", query: `${concept} b-roll`, duration_s: 10 },
      ];
      const { data: row, error } = await admin
        .from("video_creatives")
        .insert({
          brief_id: briefId,
          status: "script_ready",
          version: 1,
          // Leaving script_path null is fine — the card falls back to a
          // placeholder copy ("Script pending — Ekko is still drafting").
          script_path: null,
          broll_clips: brollClips as unknown as Json,
        })
        .select("id")
        .single();
      if (error || !row) {
        throw new Error(
          `seedIdeationVariants (video #${i + 1}) failed: ${error?.message ?? "no row returned"}`,
        );
      }
      variants.push({ id: row.id, concept });

      const evErr = await admin.from("pipeline_events").insert({
        pipeline_id: pipelineId,
        kind: "task_done",
        stage: "ideation",
        payload: {
          kind: "video",
          concept,
          creative_id: row.id,
        } as unknown as Json,
      });
      if (evErr.error) {
        throw new Error(`seedIdeationVariants (video event) failed: ${evErr.error.message}`);
      }
    }
  }

  return variants;
}

// ---------------------------------------------------------------------------
// Generation seeders — drive StageGeneration + StageDone via auto-advance
// ---------------------------------------------------------------------------

export type GenerationSeedPicks = {
  image?: string[];
  video?: string[];
};

/**
 * Seed the queued → running → done event chain for each pick so the
 * `pipeline_events_auto_advance_done_trg` trigger sees the close condition
 * and flips `status='generation'` → `status='done'` itself.
 *
 * Image picks: two task chains each (1:1 + 9:16) — matches the worker's
 * actual emission count in `_produce_generation_image_picks`. Each chain
 * is followed by inserting a finalized `creatives` row with
 * `version='v1.0'` so `StageDone`'s `ImageGallerySection` query picks it
 * up (the gallery filters out `version='v0.ideation'`).
 *
 * Video picks: six task chains each (`_VIDEO_SUBSTAGES`: script, voiceover,
 * broll_search, broll_pick, compose, caption). The last substage writes a
 * captioned `video_creatives` row in `status='captioned'` so the
 * `VideoGallerySection` query picks it up.
 *
 * Order matters for the auto-advance trigger:
 *   1. Stage_advanced→generation must already exist (the
 *      `review/decision` route writes it when the operator approves).
 *   2. Every task_queued must be matched by a task_done (or task_error).
 *      The trigger fires on each task_done/task_error insert and only
 *      flips when `(done + error) >= queued`.
 *
 * We insert each chain `queued → running → done` so the heuristic count
 * balances. The trigger's auto-flip fires on the last `task_done` row.
 */
export async function seedGenerationTasks(
  pipelineId: string,
  picks: GenerationSeedPicks,
  options: {
    /**
     * Brief id for image picks — required when picks.image is non-empty.
     * We use it as the `brief_id` on the finalized creatives rows. The
     * seeded parent ids on the prompt_used jsonb carry the original pick
     * uuid for parity with the worker's writes.
     */
    imageBriefId?: string | null;
    /**
     * Brief id for video picks — required when picks.video is non-empty.
     * Used on the finalized `video_creatives` row.
     */
    videoBriefId?: string | null;
  } = {},
): Promise<void> {
  const admin = getAdminClient();

  const imagePicks = picks.image ?? [];
  const videoPicks = picks.video ?? [];

  // -------------------------------------------------------------------
  // Image picks — 1:1 + 9:16 task chains per pick + final creative rows.
  // -------------------------------------------------------------------
  if (imagePicks.length > 0) {
    if (!options.imageBriefId) {
      throw new Error("seedGenerationTasks: imageBriefId required when picks.image is non-empty");
    }
    for (const parentId of imagePicks) {
      const parent = await admin
        .from("creatives")
        .select("concept, offer_text")
        .eq("id", parentId)
        .maybeSingle();
      const concept = (parent.data?.concept ?? `concept-${randomSuffix()}`) as string;

      for (const ratio of ["1x1", "9x16"] as const) {
        await emitTaskChain(admin, pipelineId, {
          kind: "image",
          concept,
          ratio,
          parentCreativeId: parentId,
        });

        // Insert the finalized row that StageDone will render.
        const { data: final, error: finalErr } = await admin
          .from("creatives")
          .insert({
            brief_id: options.imageBriefId,
            type: "image",
            status: "draft",
            ratio,
            version: "v1.0",
            concept,
            file_path_supabase: null,
            file_path_drive: null,
            prompt_used: {
              model: "kie/nano-banana-2",
              prompt: `Mocked final render ${concept} ${ratio}`,
              ratio,
              stage: "generation",
              parent_creative_id: parentId,
            } as unknown as Json,
          })
          .select("id")
          .single();
        if (finalErr || !final) {
          throw new Error(
            `seedGenerationTasks (final image insert) failed: ${finalErr?.message ?? "no row returned"}`,
          );
        }
      }
    }
  }

  // -------------------------------------------------------------------
  // Video picks — six substage chains each + final captioned row.
  // -------------------------------------------------------------------
  if (videoPicks.length > 0) {
    if (!options.videoBriefId) {
      throw new Error("seedGenerationTasks: videoBriefId required when picks.video is non-empty");
    }
    const substages = [
      "script",
      "voiceover",
      "broll_search",
      "broll_pick",
      "compose",
      "caption",
    ] as const;
    for (const creativeId of videoPicks) {
      for (const substage of substages) {
        await emitTaskChain(admin, pipelineId, {
          kind: "video",
          substage,
          creativeId,
        });
      }
      // Flip the picked video creative to `captioned` so the StageDone
      // gallery picks it up. `composed_path` + `captioned_path` are left
      // as stub paths — the gallery's signed-URL fetch will fail and the
      // tile renders a "No render" placeholder, which is enough for an
      // existence assertion in the spec.
      const { error: updErr } = await admin
        .from("video_creatives")
        .update({
          status: "captioned",
          composed_path: `mocked/${creativeId}-composed.mp4`,
          captioned_path: `mocked/${creativeId}-captioned.mp4`,
          duration_actual_s: 30,
        })
        .eq("id", creativeId);
      if (updErr) {
        throw new Error(`seedGenerationTasks (video creative update) failed: ${updErr.message}`);
      }
    }
  }
}

/**
 * Emit one `task_queued → task_running → task_done` chain for the given
 * payload. Used by both image (ratio chains) and video (substage chains)
 * picks. Each insert is awaited serially so the DB-side auto-advance
 * trigger sees the events in stable order — the trigger's "is everything
 * done?" probe is statement-stable, so racing inserts could otherwise
 * make it fire one round-trip too early.
 */
async function emitTaskChain(
  admin: SupabaseClient<Database>,
  pipelineId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  for (const kind of ["task_queued", "task_running", "task_done"] as const) {
    const { error } = await admin.from("pipeline_events").insert({
      pipeline_id: pipelineId,
      kind,
      stage: "generation",
      payload: payload as unknown as Json,
    });
    if (error) {
      throw new Error(`emitTaskChain (${kind}) failed: ${error.message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Status setters — useful when a spec wants to short-circuit a stage.
// ---------------------------------------------------------------------------

/**
 * Direct status setter. Silent-failure PR-4: `pipelines.status` was dropped
 * (migration 0051). The canonical answer is now the event-sourced reducer
 * `compute_pipeline_status(id)`, so seeding a status means inserting a
 * `pipeline_events(kind='stage_advanced', stage=<target>)` row -- which the
 * reducer folds into the derived status the dashboard reads. Bypasses the
 * state-machine routes entirely; the caller is responsible for any
 * upstream consistency (e.g. `picks` before flipping to `review`). Cancelled
 * is a terminal escape and uses `kind='pipeline_cancelled'` so the reducer's
 * terminal-escape branch fires.
 */
export async function seedPipelineStatus(
  pipelineId: string,
  status: Database["public"]["Enums"]["pipeline_status_enum"],
): Promise<void> {
  const admin = getAdminClient();
  const kind = status === "cancelled" ? "pipeline_cancelled" : "stage_advanced";
  const { error } = await admin
    .from("pipeline_events")
    .insert({ pipeline_id: pipelineId, kind, stage: status, payload: { seeded: true } as Json });
  if (error) {
    throw new Error(`seedPipelineStatus failed: ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Short random suffix for unique concept strings — six base-36 chars is
 * comfortably collision-free across a single test run (cleanup hooks fire
 * before AND after every spec via `_fixtures.ts`).
 */
function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 8);
}
