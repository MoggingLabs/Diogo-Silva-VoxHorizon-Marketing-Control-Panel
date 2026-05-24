/**
 * Phase clustering + stage classification for the 12-stage pipeline.
 *
 * The flat DAG (`PIPELINE_STAGES` in `./types`) is the source of order; this
 * module groups those stages into the 5 phases the manager thinks in, and
 * classifies each stage so the UI/route can decide how it advances (manual
 * gate vs auto vs hard gate) without re-deriving it from the transition table.
 */
import type { PipelineStatus } from "@/lib/pipeline/types";

export type PipelinePhase = "define" | "create" | "vet" | "pack" | "live" | "closed";

export const PIPELINE_PHASES: ReadonlyArray<{
  key: PipelinePhase;
  label: string;
  stages: ReadonlyArray<PipelineStatus>;
}> = [
  { key: "define", label: "Define", stages: ["configuration", "ideation", "review"] },
  { key: "create", label: "Create", stages: ["generation"] },
  {
    key: "vet",
    label: "Vet",
    stages: ["creative_qa", "compliance_review", "copy", "spec_validation"],
  },
  { key: "pack", label: "Pack", stages: ["variant_plan", "finalize_assets"] },
  { key: "live", label: "Live", stages: ["launch_handoff", "monitor"] },
  { key: "closed", label: "Done", stages: ["done", "cancelled"] },
] as const;

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

export function stageClass(status: PipelineStatus): StageClass {
  switch (status) {
    case "configuration":
    case "review":
    case "variant_plan":
    case "monitor":
      return "human_gate";
    case "ideation":
    case "generation":
      return "agent_work";
    case "creative_qa":
    case "copy":
    case "spec_validation":
      // spec_validation is a per-creative gate (it sits in PER_CREATIVE_STAGES,
      // the advance route gates it on the rollup, and StageCreativeReview shows
      // its Continue button). Classifying it `auto` was a stall trap (E2.5): no
      // trigger or worker auto-advances spec_validation→variant_plan.
      return "per_creative";
    case "compliance_review":
    case "launch_handoff":
      return "hard_gate";
    case "finalize_assets":
      return "auto";
    case "done":
    case "cancelled":
      return "terminal";
  }
}
