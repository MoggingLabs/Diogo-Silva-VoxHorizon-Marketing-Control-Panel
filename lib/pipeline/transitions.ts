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
 * How a stage hands off to its successor — drives BOTH the route that commits
 * the move and whether the UI shows a manual "Continue" button.
 *
 *  - `gate`     — manager advances via the generic `/advance` route when the
 *                 stage's predicate (below) is satisfied; the UI shows a manual
 *                 "Continue" button.
 *  - `auto`     — the workflow advances it (DB trigger / worker on completion);
 *                 no manual button. ONLY `generation→creative_qa` (the 0024
 *                 trigger) and `finalize_assets→launch_handoff` (closed by the
 *                 operator finalize tools + the route's finalize gate).
 *  - `decision` — advances via a dedicated decision route that records a human
 *                 choice: `review` (approve/reject), `launch_handoff` (HARD
 *                 launch gate), `monitor` (kill/scale).
 *  - `terminal` — `done` / `cancelled`.
 *
 * E2.5 fix: `spec_validation` is a per-creative GATE, not `auto`. It is a member
 * of {@link PER_CREATIVE_STAGES}, the advance route gates it on the rollup, and
 * the StageCreativeReview UI shows its Continue button — classifying it `auto`
 * (no button, "the workflow advances it") was a stall trap, since NOTHING
 * auto-advances `spec_validation→variant_plan`.
 */
export type AdvanceMechanism = "gate" | "auto" | "decision" | "terminal";

export function advanceMechanism(status: PipelineStatus): AdvanceMechanism {
  switch (status) {
    case "configuration":
    case "ideation":
    case "creative_qa":
    case "compliance_review":
    case "copy":
    case "spec_validation":
    case "variant_plan":
      return "gate";
    case "generation":
    case "finalize_assets":
      return "auto";
    case "review":
    case "launch_handoff":
    case "monitor":
      return "decision";
    case "done":
    case "cancelled":
      return "terminal";
  }
}

/** The four per-creative stages whose gate is the creative_stage_state rollup. */
export const PER_CREATIVE_STAGES = new Set<PipelineStatus>([
  "creative_qa",
  "compliance_review",
  "copy",
  "spec_validation",
]);

/**
 * Per-creative + launch gate inputs the pure machine cannot derive from the
 * pipeline row alone. The caller (advance route / UI) computes these from
 * `creative_stage_state` (mirroring the DB `pipeline_rollup_cleared()`) and the
 * launch preconditions, and passes them in.
 */
export type GateContext = {
  /**
   * For a per-creative stage: every picked, non-killed creative is
   * passed | overridden | skipped (and ≥1 exists). For compliance this also
   * encodes the HARD block — a creative `failed` without an audited override
   * keeps the rollup UNcleared, so the gate stays shut.
   */
  rollupCleared?: boolean;
  /** launch_handoff: spec-pass ∧ compliance-clear ∧ ≥3 approved copy/creative. */
  launchPreconditionsMet?: boolean;
};

/** Which picks are missing for the active tracks (ideation → review gate). */
function missingPicksForFormat(
  format: PipelineFormat,
  picks: { image?: string[]; video?: string[] } | null,
): string[] {
  const tracks = activeTracksLocal(format);
  const missing: string[] = [];
  const has = (arr: string[] | undefined) => Array.isArray(arr) && arr.length > 0;
  if (tracks.image && !has(picks?.image)) missing.push("image");
  if (tracks.video && !has(picks?.video)) missing.push("video");
  return missing;
}

/**
 * Decide whether the given pipeline can step to its next stage right now. This
 * is the single source of truth for every forward edge's gate predicate, used
 * by the advance/decision routes AND the UI Continue button so they agree.
 *
 * `auto` stages return their predicate too (so the route/trigger can assert it)
 * but the UI keys off {@link advanceMechanism} to decide whether to show a
 * button. The hard-locked states (`done`, `cancelled`) always refuse.
 */
export function canAdvance(
  pipeline: Pick<Pipeline, "status" | "format_choice" | "config_draft"> &
    Partial<Pick<Pipeline, "picks">>,
  gate: GateContext = {},
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
    case "ideation": {
      const missing = missingPicksForFormat(
        pipeline.format_choice as PipelineFormat,
        (pipeline.picks ?? null) as { image?: string[]; video?: string[] } | null,
      );
      if (missing.length > 0) {
        return { ok: false, reason: `no concept picks for: ${missing.join(", ")}`, missing };
      }
      return { ok: true, next: "review" };
    }
    case "review":
      // The manager approves/rejects via the review-decision route; the gate
      // predicate (picks present) was satisfied to reach review.
      return { ok: true, next: "generation" };
    case "generation":
      // Auto-advanced by the DB trigger once renders close (and >=1 succeeds).
      return { ok: false, reason: "generation auto-advances on render completion" };
    case "creative_qa":
    case "compliance_review":
    case "copy":
    case "spec_validation": {
      const next = nextStage(pipeline.status)!;
      if (!gate.rollupCleared) {
        return {
          ok: false,
          reason:
            pipeline.status === "compliance_review"
              ? "compliance is a HARD gate: every creative must pass or be overridden"
              : `${pipeline.status} not cleared for all picked creatives`,
        };
      }
      return { ok: true, next };
    }
    case "variant_plan":
      // Manager approves the A/B test plan, then advances.
      return { ok: true, next: "finalize_assets" };
    case "finalize_assets":
      // Auto once assets are named/uploaded/verified.
      return { ok: true, next: "launch_handoff" };
    case "launch_handoff":
      // HARD launch gate: preconditions must hold; the launch-decision route
      // adds the explicit human approval before any Meta spend.
      if (!gate.launchPreconditionsMet) {
        return {
          ok: false,
          reason: "launch blocked: spec-pass + compliance-clear + >=3 approved copy required",
        };
      }
      return { ok: true, next: "monitor" };
    case "monitor":
      // Manager records kill/scale via the monitor-decision route.
      return { ok: true, next: "done" };
    case "done":
      return { ok: false, reason: "pipeline already done" };
    case "cancelled":
      return { ok: false, reason: "pipeline is cancelled" };
    default: {
      // Exhaustiveness: TS errors here if a new status enters the type without
      // a branch above.
      const _exhaustive: never = pipeline.status as never;
      return { ok: false, reason: `unknown status: ${String(_exhaustive)}` };
    }
  }
}

/**
 * The successor of each stage in the 12-stage DAG. Useful for UI labels
 * ("Continue to Compliance") even before the gate is satisfied. Returns null
 * at the terminal stages.
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
      return "creative_qa";
    case "creative_qa":
      return "compliance_review";
    case "compliance_review":
      return "copy";
    case "copy":
      return "spec_validation";
    case "spec_validation":
      return "variant_plan";
    case "variant_plan":
      return "finalize_assets";
    case "finalize_assets":
      return "launch_handoff";
    case "launch_handoff":
      return "monitor";
    case "monitor":
      return "done";
    case "done":
    case "cancelled":
      return null;
  }
}
