/**
 * Phase clustering + stage classification for the 12-stage pipeline.
 *
 * The flat DAG (`PIPELINE_STAGES` in `./types`) is the source of order; this
 * module groups those stages into the 5 phases the manager thinks in, and
 * classifies each stage so the UI/route can decide how it advances (manual
 * gate vs auto vs hard gate) without re-deriving it from the transition table.
 */
import { PIPELINE_STAGE_REGISTRY, stageDef } from "@/lib/pipeline/stages";
import type { PipelineStatus } from "@/lib/pipeline/types";

export type PipelinePhase = "define" | "create" | "vet" | "pack" | "live" | "closed";

/** Ordered phase keys + their display labels. The membership of each phase is
 * DERIVED from the stage registry's `phase` field below, so a stage's phase
 * lives in exactly one place (`./stages`, the E2.1 single source of truth). */
const PHASE_LABELS: ReadonlyArray<{ key: PipelinePhase; label: string }> = [
  { key: "define", label: "Define" },
  { key: "create", label: "Create" },
  { key: "vet", label: "Vet" },
  { key: "pack", label: "Pack" },
  { key: "live", label: "Live" },
  { key: "closed", label: "Done" },
] as const;

export const PIPELINE_PHASES: ReadonlyArray<{
  key: PipelinePhase;
  label: string;
  stages: ReadonlyArray<PipelineStatus>;
}> = PHASE_LABELS.map(({ key, label }) => ({
  key,
  label,
  stages: PIPELINE_STAGE_REGISTRY.filter((s) => s.phase === key).map(
    (s) => s.key as PipelineStatus,
  ),
}));

const STATUS_TO_PHASE: Record<PipelineStatus, PipelinePhase> = (() => {
  const m = {} as Record<PipelineStatus, PipelinePhase>;
  for (const p of PIPELINE_PHASES) for (const s of p.stages) m[s] = p.key;
  return m;
})();

export function phaseForStatus(status: PipelineStatus): PipelinePhase {
  return STATUS_TO_PHASE[status];
}

/**
 * What kind of work a stage is — drives UI affordances (badge, whether to show
 * a Continue button, override controls). Mirrors the orchestration design:
 *  - human_gate  : manager approves to advance.
 *  - agent_work  : the operator/worker produces; advances on completion.
 *  - per_creative: a grid of creatives each cleared independently (rollup gate).
 *  - hard_gate   : per-creative + a non-bypassable block (compliance) or an
 *                  irreversible-spend gate (launch). Override/approval is audited.
 *  - auto        : advances automatically when its rollup/work closes.
 *  - terminal    : done / cancelled.
 */
export type StageClass =
  | "human_gate"
  | "agent_work"
  | "per_creative"
  | "hard_gate"
  | "auto"
  | "terminal";

/**
 * The UI class of a stage. DERIVED from the stage registry (`./stages`, the
 * E2.1 single source of truth) so it cannot drift from `advanceMechanism`, the
 * worker `PipelineStage` Literal, or the DB enum.
 *
 * Note (E2.5): `spec_validation` is `per_creative`, NOT `auto` -- it sits in
 * PER_CREATIVE_STAGES, the advance route gates it on the rollup, and
 * StageCreativeReview shows its Continue button. Classifying it `auto` was a
 * stall trap: nothing auto-advances spec_validation->variant_plan. That
 * classification now lives in the registry.
 */
export function stageClass(status: PipelineStatus): StageClass {
  return stageDef(status).stageClass;
}
