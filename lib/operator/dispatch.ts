import "server-only";

import type { PipelineStatus } from "@/lib/pipeline/types";

/**
 * Server-side helper to re-task the Hermes "operator" agent.
 *
 * The operator runs the image-ad pipeline like a hired employee. The
 * dashboard's role is supervision: the manager kicks off a run and signs off
 * at the stage gates, and each gate re-tasks the operator for the next stage.
 * The actual nudge is a fire-and-forget POST to the worker's
 * `POST {WORKER_URL}/work/pipeline/tools/dispatch` endpoint (Wave A), which
 * runs `hermes chat -q <instruction> --pass-session-id <pipeline_id>` inside
 * the operator container and returns immediately.
 *
 * This module owns the single source of truth for:
 *   - the worker call (bearer auth, swallow-on-404, never block the caller);
 *   - the canonical instruction strings the gates use to re-task the operator.
 *
 * Every call site (`/api/pipelines/operator` kickoff, `.../advance`,
 * `.../picks`, `.../review/decision`) goes through `dispatchOperator` so the
 * auth + failure semantics stay identical to the existing
 * `fireWorkerIdeation` / `fireWorkerGeneration` helpers: if the worker isn't
 * configured (WORKER_URL / WORKER_SHARED_SECRET unset) we skip silently, a
 * 404 means "endpoint not deployed yet" and is swallowed, and anything else
 * throws so the caller's `.catch()` can log it without failing the request.
 */

export type OperatorStage =
  | "configuration"
  | "ideation"
  | "review"
  | "generation"
  | "creative_qa"
  | "compliance_review"
  | "copy"
  | "spec_validation"
  | "variant_plan"
  | "finalize_assets"
  | "launch_handoff"
  | "monitor";

/**
 * Build the natural-language instruction the operator receives for a given
 * stage. The operator's playbook (Wave B) keys off the pipeline_id (its
 * session id) to read live state, so the instruction only needs to name the
 * pipeline and the intent. An optional free-text brief rides along on
 * kickoff.
 */
export function operatorInstruction(
  stage: OperatorStage,
  pipelineId: string,
  brief?: string,
): string {
  switch (stage) {
    case "configuration": {
      const ask = brief?.trim()
        ? `The manager's brief: ${brief.trim()}`
        : "Use the client + format on the pipeline to draft the image brief.";
      return `You are the operator for pipeline ${pipelineId}. ${ask} Read the pipeline state, author the image brief, and stop for the manager's review.`;
    }
    case "ideation":
      return `The manager approved the brief for pipeline ${pipelineId}. Author the concept previews (one render call = one spend gate) and stop for the manager's picks.`;
    case "generation":
      return `The manager picked the concepts for pipeline ${pipelineId}. Render the final assets for the picked concepts, then stop — the pipeline finishes itself.`;
    case "review":
      // Review is a pure manager gate (approve/reject the picks); the operator
      // has nothing to do until it transitions to generation. Exposed for
      // completeness so callers don't special-case the enum.
      return `Pipeline ${pipelineId} is awaiting the manager's review. Stand by.`;
    case "creative_qa":
      return `Run the QA pass on each final for pipeline ${pipelineId}: pass/fail with defects, flag re-renders, then stop for the manager's QA sign-off.`;
    case "compliance_review":
      return `Screen each final and its copy against the Meta/FTC ruleset for pipeline ${pipelineId}. Record pass/block with required edits. You cannot pass a blocked item — stop for the manager.`;
    case "copy":
      return `Author the copy for pipeline ${pipelineId}: three variants per final, owner voice, sourced from the winning-copy registry and humanized. Stop for the manager's copy approval.`;
    case "spec_validation":
      return `Validate placement specs and derive the crops for pipeline ${pipelineId}; surface any exceptions, then stop.`;
    case "variant_plan":
      return `Build the A/B test matrix for pipeline ${pipelineId}, one variable per cell, sized to the budget. Stop for the manager's test-plan approval.`;
    case "finalize_assets":
      return `Finalize assets for pipeline ${pipelineId}: apply the naming convention, register, upload to Drive, and verify. Stop with the verify report.`;
    case "launch_handoff":
      return `Assemble and validate the launch package for pipeline ${pipelineId}. Do not touch Meta without an explicit approval naming the live action; create PAUSED first. Stop at the launch gate.`;
    case "monitor":
      return `Monitor the live ads for pipeline ${pipelineId}. Pull GHL leads as the source of truth, apply the kill/watch/keep thresholds, and recommend kill or scale. Stop for the manager's call.`;
  }
}

/**
 * Whether a pipeline is operator-driven (created via the kickoff route) rather
 * than a regular dashboard pipeline.
 *
 * This is the switch that keeps the two execution models from colliding:
 *   - operator-driven → the Hermes operator authors + renders (one
 *     spend-gated render path); the gate routes MUST NOT also fire the
 *     deterministic `/work/pipeline/{ideation,generation}` producers, or every
 *     concept + final would render twice and double the Kie spend.
 *   - regular → the deterministic producers run as before and the operator is
 *     never dispatched.
 *
 * The kickoff route stamps `config_draft.operator_driven = true`; we also treat
 * a stored `operator_instruction` as the marker so rows created before the
 * explicit flag existed still resolve correctly.
 */
export function isOperatorDriven(configDraft: unknown): boolean {
  if (!configDraft || typeof configDraft !== "object" || Array.isArray(configDraft)) {
    return false;
  }
  const draft = configDraft as Record<string, unknown>;
  if (draft.operator_driven === true) return true;
  return (
    typeof draft.operator_instruction === "string" && draft.operator_instruction.trim().length > 0
  );
}

/**
 * Fire-and-forget POST to the worker's operator dispatch endpoint. Resolves
 * once the worker has acknowledged the kick (the worker itself runs the
 * operator in the background). Mirrors `fireWorkerIdeation`'s contract:
 *
 *   - returns early (no-op) when WORKER_URL / WORKER_SHARED_SECRET are unset,
 *     so unit tests and local dev don't need a live worker;
 *   - swallows a 404 (endpoint not deployed) silently;
 *   - throws on any other non-2xx so the caller's `.catch()` can log it.
 *
 * Call sites should `void dispatchOperator(...).catch((e) => console.warn(...))`
 * — a worker outage must never block a stage transition or kickoff, since the
 * pipeline row + events are the primary artifacts.
 */
/**
 * Typed dispatch envelope. The operator asserts `pipeline.status ===
 * expected_status` on read and stops (no-op) if it mismatches — this kills the
 * stale/duplicate-dispatch race (the stage already advanced or was raced).
 */
export type DispatchEnvelope = {
  stage?: OperatorStage;
  expectedStatus?: PipelineStatus;
  dispatchId?: string;
};

export async function dispatchOperator(
  pipelineId: string,
  instruction: string,
  envelope: DispatchEnvelope = {},
): Promise<void> {
  const base = process.env.WORKER_URL?.replace(/\/$/, "");
  const secret = process.env.WORKER_SHARED_SECRET;
  if (!base || !secret) return;
  const res = await fetch(`${base}/work/pipeline/tools/dispatch`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secret}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      pipeline_id: pipelineId,
      instruction,
      stage: envelope.stage,
      expected_status: envelope.expectedStatus,
      dispatch_id: envelope.dispatchId,
    }),
    cache: "no-store",
  });
  if (!res.ok && res.status !== 404) {
    const text = await res.text().catch(() => "");
    throw new Error(`worker /work/pipeline/tools/dispatch -> ${res.status}: ${text.slice(0, 200)}`);
  }
}
