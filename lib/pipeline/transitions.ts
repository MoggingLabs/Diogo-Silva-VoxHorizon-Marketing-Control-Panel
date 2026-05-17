/**
 * Pipeline state-machine validators.
 *
 * The pipeline lifecycle is linear with one terminal escape (`cancelled`):
 *
 *   configuration → ideation → review → generation → done
 *                                                  ↘ cancelled (from any stage)
 *
 * The `canAdvance` helper is the single source of truth for "can this pipeline
 * legally move to its next stage right now?". It returns a structured result
 * so callers (the `/api/pipelines/[id]/advance` route, the StageShell CTA gate)
 * can either accept the move or surface the precise blocker to the operator
 * without re-implementing the logic.
 *
 * This module is pure — no DB access, no IO. The caller hydrates the pipeline
 * row and asks here; the API layer commits the side-effects after.
 *
 * Wave 10 / PF-B scope only fully implements `configuration → ideation`. Later
 * milestones (PF-C / PF-D / PF-E) extend the helper as each stage gate solidifies.
 */
import type { Pipeline, PipelineFormat, PipelineStatus } from "@/lib/pipeline/types";

/**
 * Result of asking whether a pipeline can advance from its current stage. We
 * return both a boolean and a (when blocked) human-readable reason so the
 * server can pick a 422 status + the UI can render a tooltip without a
 * round-trip translation table.
 */
export type AdvanceCheck =
  | { ok: true; next: PipelineStatus }
  | { ok: false; reason: string; missing?: string[] };

/**
 * Which "tracks" are active for a given format choice. Both `image` and
 * `both` require an image brief; both `video` and `both` require a video
 * brief. This local helper mirrors the (Agent-Y-owned) `activeTracks` in
 * `lib/pipeline/tracks.ts`; they ship the same shape so the rebase is
 * trivial.
 */
export function activeTracksLocal(format: PipelineFormat): {
  image: boolean;
  video: boolean;
} {
  return {
    image: format === "image" || format === "both",
    video: format === "video" || format === "both",
  };
}

/**
 * Read `config_draft` and report which active-track payload(s) are missing.
 * "Missing" means absent / null / not a plain object — we don't validate the
 * inner shape here (the advance route's zod parse does that). This gate just
 * answers: "do we have something to write the brief row from?".
 */
function missingPayloadsForFormat(
  format: PipelineFormat,
  draft: Record<string, unknown> | null,
): string[] {
  const tracks = activeTracksLocal(format);
  const missing: string[] = [];
  const isObj = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v);
  const draftObj = isObj(draft) ? draft : null;

  if (tracks.image && !isObj(draftObj?.image_payload)) {
    missing.push("image_payload");
  }
  if (tracks.video && !isObj(draftObj?.video_payload)) {
    missing.push("video_payload");
  }
  return missing;
}

/**
 * Decide whether the given pipeline can step to its next stage right now.
 *
 * For `configuration → ideation` we require the format-appropriate
 * payloads to live in `config_draft`. The other transitions are stubbed to
 * "not yet supported" — later milestones flesh them out.
 *
 * The hard-locked states (`done`, `cancelled`) always refuse.
 */
export function canAdvance(
  pipeline: Pick<Pipeline, "status" | "format_choice" | "config_draft">,
): AdvanceCheck {
  switch (pipeline.status) {
    case "configuration": {
      const missing = missingPayloadsForFormat(
        pipeline.format_choice as PipelineFormat,
        pipeline.config_draft as Record<string, unknown> | null,
      );
      if (missing.length > 0) {
        return {
          ok: false,
          reason: `config_draft is missing required payloads: ${missing.join(", ")}`,
          missing,
        };
      }
      return { ok: true, next: "ideation" };
    }
    case "ideation":
    case "review":
    case "generation":
      return {
        ok: false,
        reason: `transition not yet supported (from=${pipeline.status})`,
      };
    case "done":
      return { ok: false, reason: "pipeline already done" };
    case "cancelled":
      return { ok: false, reason: "pipeline is cancelled" };
    default: {
      // Exhaustiveness: TS will complain here if a new status enters the
      // type without a branch above.
      const _exhaustive: never = pipeline.status as never;
      return { ok: false, reason: `unknown status: ${String(_exhaustive)}` };
    }
  }
}

/**
 * The successor of each stage in the linear happy-path. Useful for UI labels
 * ("Continue to Ideation") even before the gate is satisfied. Returns null at
 * the terminal stages.
 */
export function nextStage(status: PipelineStatus): PipelineStatus | null {
  switch (status) {
    case "configuration":
      return "ideation";
    case "ideation":
      return "review";
    case "review":
      return "generation";
    case "generation":
      return "done";
    case "done":
    case "cancelled":
      return null;
  }
}
