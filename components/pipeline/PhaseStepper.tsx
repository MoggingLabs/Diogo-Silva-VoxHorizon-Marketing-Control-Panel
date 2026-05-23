"use client";

import { Check } from "lucide-react";

import { cn } from "@/lib/utils";
import { PIPELINE_PHASES, phaseForStatus, type PipelinePhase } from "@/lib/pipeline/phases";
import { PIPELINE_STATUS_LABEL, type PipelineStatus } from "@/lib/pipeline/types";

/**
 * Five-phase clustered stepper (Define / Create / Vet / Pack / Live) for the
 * run view (#356, P4.1). Replaces the flat 12-status `HorizontalStepper` with
 * the five phases the manager actually thinks in, derived from
 * `PIPELINE_PHASES`. Each phase shows its constituent stages; the current
 * stage is highlighted inside its phase.
 *
 * Strangler-fig: every legacy status still maps to a phase via
 * `phaseForStatus`, so a live run on any of the 14 statuses renders without a
 * gap. `cancelled` lives in the terminal `closed` phase but is rendered with a
 * neutral "off-path" treatment (it's an escape, not a forward step).
 */
export type PhaseStepperProps = {
  /** The pipeline's current status — drives the active phase + active stage. */
  current: PipelineStatus;
  className?: string;
};

type PhaseState = "past" | "active" | "future";

/** The forward order of phases (closed is terminal). */
const PHASE_ORDER: PipelinePhase[] = PIPELINE_PHASES.map((p) => p.key);

function phaseState(activePhase: PipelinePhase, phase: PipelinePhase): PhaseState {
  const activeIdx = PHASE_ORDER.indexOf(activePhase);
  const idx = PHASE_ORDER.indexOf(phase);
  if (idx < activeIdx) return "past";
  if (idx === activeIdx) return "active";
  return "future";
}

export function PhaseStepper({ current, className }: PhaseStepperProps) {
  const activePhase = phaseForStatus(current);
  const isCancelled = current === "cancelled";

  return (
    <ol
      aria-label="Pipeline phases"
      data-testid="phase-stepper"
      data-active-phase={activePhase}
      className={cn("flex w-full flex-col gap-3 sm:flex-row sm:items-stretch sm:gap-2", className)}
    >
      {PIPELINE_PHASES.map((phase, idx) => {
        const state = phaseState(activePhase, phase.key);
        const isActivePhase = state === "active";

        return (
          <li
            key={phase.key}
            data-testid={`phase-${phase.key}`}
            data-state={state}
            aria-current={isActivePhase ? "step" : undefined}
            className="flex flex-1 flex-col gap-2"
          >
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border-2 text-xs font-semibold",
                  state === "past" && "border-emerald-500 bg-emerald-500 text-white",
                  state === "active" && "border-sky-500 bg-sky-500 text-white",
                  state === "future" && "border-border bg-background text-muted-foreground",
                )}
              >
                {state === "past" ? (
                  <Check className="h-4 w-4" aria-hidden="true" />
                ) : (
                  <span>{idx + 1}</span>
                )}
              </span>
              <span
                className={cn(
                  "text-sm font-semibold tracking-tight",
                  state === "active" ? "text-foreground" : "text-muted-foreground",
                )}
              >
                {phase.label}
              </span>
            </div>

            <ul className="flex flex-wrap gap-1 pl-9 sm:pl-0">
              {phase.stages.map((stage) => {
                const isCurrentStage = stage === current;
                // A cancelled run highlights nothing in the forward path; the
                // cancelled chip itself (in the closed phase) reads as the state.
                const highlight = isCurrentStage && !(isCancelled && stage !== "cancelled");
                return (
                  <li
                    key={stage}
                    data-testid={`phase-stage-${stage}`}
                    data-current={isCurrentStage ? "true" : undefined}
                    className={cn(
                      "rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset",
                      highlight
                        ? stage === "cancelled"
                          ? "bg-destructive/10 text-destructive ring-destructive/30"
                          : "bg-sky-100 text-sky-900 ring-sky-300 dark:bg-sky-950/40 dark:text-sky-200 dark:ring-sky-800"
                        : "bg-muted text-muted-foreground ring-border",
                    )}
                  >
                    {PIPELINE_STATUS_LABEL[stage]}
                  </li>
                );
              })}
            </ul>
          </li>
        );
      })}
    </ol>
  );
}
