/**
 * Per-creative autonomy resolution for the approval-mode extension (#363, P4.8).
 *
 * The ASK / AUTO_APPROVE / HALT toggle (`lib/approval-mode/types.ts`) controls
 * whether the agent's tool calls run without an operator decision. The rebuild
 * extends this to *per-creative autonomy* on the four per-creative stages — but
 * with one inviolable rule from the architecture:
 *
 *   **Hard gates never auto-pass.** Even in AUTO_APPROVE, compliance_review and
 *   launch_handoff require an audited human action to clear. AUTO must be
 *   ignored for them.
 *
 * This is the single predicate the UI (the grid's Continue button, the gate
 * components) and any auto-advance path read so they agree by construction.
 * Pure — no React, no IO.
 */
import type { ApprovalMode } from "@/lib/approval-mode/types";
import { stageClass } from "@/lib/pipeline/phases";
import type { PipelineStatus } from "@/lib/pipeline/types";

/** Why a stage may or may not auto-advance under the current approval mode. */
export type AutonomyDecision = {
  /** True only when the stage may advance without an explicit human action. */
  autoAllowed: boolean;
  /** True for compliance_review / launch_handoff — AUTO is always ignored. */
  hardGate: boolean;
  /** Human-readable reason, for tooltips / audit. */
  reason: string;
};

/**
 * Decide whether `status` may auto-advance under `mode`.
 *
 *   - HALT          → never auto (everything waits for a human).
 *   - hard gate     → never auto, regardless of mode (compliance / launch).
 *   - AUTO_APPROVE  → auto-allowed for non-hard stages.
 *   - ASK (default) → never auto (the manager decides at the gate).
 *
 * Note this only governs *autonomy*; the per-creative rollup / launch
 * preconditions still have to be satisfied for the move to be legal. A stage
 * that is `autoAllowed` AND whose gate predicate holds may advance without a
 * click; otherwise the manager acts at the gate.
 */
export function resolveAutonomy(mode: ApprovalMode, status: PipelineStatus): AutonomyDecision {
  const hardGate = status === "compliance_review" || status === "launch_handoff";

  if (hardGate) {
    return {
      autoAllowed: false,
      hardGate: true,
      reason: "hard gate — requires an audited human action even under AUTO_APPROVE",
    };
  }

  if (mode === "HALT") {
    return { autoAllowed: false, hardGate: false, reason: "HALT — all gates require a human" };
  }

  if (mode === "AUTO_APPROVE") {
    return {
      autoAllowed: true,
      hardGate: false,
      reason: "AUTO_APPROVE — non-hard gates advance once their rollup clears",
    };
  }

  // ASK (and any unexpected value) → conservative: the manager decides.
  return { autoAllowed: false, hardGate: false, reason: "ASK — the manager decides at the gate" };
}

/**
 * Convenience: would this status auto-advance under `mode`? Thin wrapper over
 * {@link resolveAutonomy} for call sites that only need the boolean.
 */
export function canAutoAdvance(mode: ApprovalMode, status: PipelineStatus): boolean {
  return resolveAutonomy(mode, status).autoAllowed;
}

/**
 * Whether a status is a hard gate (compliance / launch). Re-exported here as
 * the canonical predicate so callers don't re-derive it from `stageClass`,
 * though they agree: `stageClass` returns `"hard_gate"` for exactly these two.
 */
export function isHardGate(status: PipelineStatus): boolean {
  return stageClass(status) === "hard_gate";
}
