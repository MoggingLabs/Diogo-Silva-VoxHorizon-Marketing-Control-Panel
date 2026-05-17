"use client";

import { Check } from "lucide-react";

import { cn } from "@/lib/utils";
import type { PipelineStatus } from "@/lib/pipeline/types";

type Stage = { key: PipelineStatus; label: string };

export type HorizontalStepperProps = {
  /** Ordered list of stages from left to right. */
  stages: Stage[];
  /** The currently active stage. */
  current: PipelineStatus;
  /**
   * Click handler for past stages. Future stages are never clickable and
   * the active stage is non-interactive (you're already there).
   */
  onStageClick?: (stage: PipelineStatus) => void;
};

type StageState = "past" | "active" | "future";

function stageState(stages: Stage[], current: PipelineStatus, idx: number): StageState {
  const activeIdx = stages.findIndex((s) => s.key === current);
  // If `current` is a status not in the stepper (e.g. `cancelled`), treat all
  // stages as future so nothing renders as completed.
  if (activeIdx < 0) return "future";
  if (idx < activeIdx) return "past";
  if (idx === activeIdx) return "active";
  return "future";
}

/**
 * Five-stage horizontal stepper used at the top of `/pipeline/[id]`.
 *
 * Visual states:
 *  - past   — green check, clickable, transparent connector to the right is green
 *  - active — blue filled circle with a pulse ring and label underneath
 *  - future — grey outline, not interactive, grey connector
 *
 * Below the `md` breakpoint the row collapses to a compact vertical pill stack
 * so the steps remain readable on narrow screens.
 */
export function HorizontalStepper({ stages, current, onStageClick }: HorizontalStepperProps) {
  return (
    <>
      {/* Desktop: horizontal row */}
      <ol aria-label="Pipeline progress" className="hidden w-full items-start gap-0 md:flex">
        {stages.map((stage, idx) => {
          const state = stageState(stages, current, idx);
          const next = stages[idx + 1];
          const nextState = next ? stageState(stages, current, idx + 1) : null;
          const isLast = idx === stages.length - 1;
          const clickable = state === "past" && typeof onStageClick === "function";

          return (
            <li
              key={stage.key}
              className="flex flex-1 items-start"
              aria-current={state === "active" ? "step" : undefined}
            >
              <div className="flex flex-1 flex-col items-center text-center">
                <button
                  type="button"
                  disabled={!clickable}
                  onClick={clickable ? () => onStageClick?.(stage.key) : undefined}
                  className={cn(
                    "relative inline-flex h-9 w-9 items-center justify-center rounded-full border-2 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                    state === "past" &&
                      "cursor-pointer border-emerald-500 bg-emerald-500 text-white hover:bg-emerald-600",
                    state === "active" && "cursor-default border-sky-500 bg-sky-500 text-white",
                    state === "future" &&
                      "cursor-not-allowed border-border bg-background text-muted-foreground",
                  )}
                  aria-label={`${stage.label} — ${state}`}
                >
                  {state === "active" ? (
                    <span
                      aria-hidden="true"
                      className="absolute inset-0 animate-ping rounded-full bg-sky-400/40"
                    />
                  ) : null}
                  {state === "past" ? (
                    <Check className="h-4 w-4" aria-hidden="true" />
                  ) : (
                    <span className="relative">{idx + 1}</span>
                  )}
                </button>
                <span
                  className={cn(
                    "mt-2 text-xs font-medium sm:text-sm",
                    state === "active"
                      ? "text-foreground"
                      : state === "past"
                        ? "text-foreground/80"
                        : "text-muted-foreground",
                  )}
                >
                  {stage.label}
                </span>
              </div>
              {!isLast ? (
                <div
                  className={cn(
                    "mt-4 h-0.5 flex-1 self-start rounded-full",
                    state === "past" && nextState === "past" && "bg-emerald-500",
                    state === "past" &&
                      nextState === "active" &&
                      "bg-gradient-to-r from-emerald-500 to-sky-500",
                    state === "active" && "bg-gradient-to-r from-sky-500 to-border",
                    state === "future" && "bg-border",
                  )}
                  aria-hidden="true"
                />
              ) : null}
            </li>
          );
        })}
      </ol>

      {/* Mobile: vertical pill stack */}
      <ol aria-label="Pipeline progress" className="flex flex-col gap-1 md:hidden">
        {stages.map((stage, idx) => {
          const state = stageState(stages, current, idx);
          const clickable = state === "past" && typeof onStageClick === "function";

          return (
            <li key={stage.key} aria-current={state === "active" ? "step" : undefined}>
              <button
                type="button"
                disabled={!clickable}
                onClick={clickable ? () => onStageClick?.(stage.key) : undefined}
                className={cn(
                  "flex w-full items-center gap-3 rounded-full border px-3 py-2 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  state === "past" &&
                    "cursor-pointer border-emerald-500/40 bg-emerald-50 text-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-200",
                  state === "active" &&
                    "cursor-default border-sky-500 bg-sky-50 text-sky-900 dark:bg-sky-950/30 dark:text-sky-200",
                  state === "future" &&
                    "cursor-not-allowed border-border bg-background text-muted-foreground",
                )}
                aria-label={`${stage.label} — ${state}`}
              >
                <span
                  className={cn(
                    "relative inline-flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold",
                    state === "past" && "bg-emerald-500 text-white",
                    state === "active" && "bg-sky-500 text-white",
                    state === "future" && "border border-border bg-background",
                  )}
                >
                  {state === "active" ? (
                    <span
                      aria-hidden="true"
                      className="absolute inset-0 animate-ping rounded-full bg-sky-400/40"
                    />
                  ) : null}
                  {state === "past" ? (
                    <Check className="h-3 w-3" aria-hidden="true" />
                  ) : (
                    <span className="relative">{idx + 1}</span>
                  )}
                </span>
                <span className="font-medium">{stage.label}</span>
              </button>
            </li>
          );
        })}
      </ol>
    </>
  );
}
