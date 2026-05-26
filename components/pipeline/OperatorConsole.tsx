"use client";

import * as React from "react";
import Link from "next/link";
import type { Route } from "next";
import { useRouter } from "next/navigation";
import { Bot, ChevronDown, ChevronUp, Factory, Gauge, Radio } from "lucide-react";

import { EmptyState } from "@/components/EmptyState";
import { OperatorKickoffForm } from "@/components/pipeline/OperatorKickoffForm";
import { OperatorNarration } from "@/components/pipeline/OperatorNarration";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { useRealtimeStream } from "@/hooks/useRealtimeStream";
import type { OperatorRun } from "@/lib/operator/console";
import { PIPELINE_STATUS_LABEL, type PipelineStatus } from "@/lib/pipeline/types";
import { timeSince } from "@/lib/format-time";
import { cn } from "@/lib/utils";

/**
 * Operator Console (E5.3 / #597).
 *
 * Promotes the kickoff-only page into a real supervision console: the active
 * operator runs (status + stage), the live narration feed for the selected run,
 * a per-stage gate call-to-action where the manager's sign-off is required, and
 * the kickoff form. Reuses `OperatorNarration` (realtime via the SSE relay) and
 * the existing kickoff form; new runs / stage transitions surface live via the
 * `pipelines` realtime channel.
 *
 * Gate actions are deliberately a deep-link to the run, NOT an inline decision:
 * the HARD gates (variant_plan / launch_handoff / monitor) re-derive their
 * preconditions server-side in the detail page's gate components + decision
 * routes, which we must never bypass.
 */

/** Stages where the manager's sign-off / decision is the next action. */
const GATE_STAGES: Partial<Record<PipelineStatus, string>> = {
  review: "Brief review awaiting sign-off",
  creative_qa: "Creative QA awaiting review",
  compliance_review: "Compliance gate awaiting review",
  spec_validation: "Spec validation awaiting review",
  variant_plan: "A/B plan awaiting approval",
  launch_handoff: "Launch gate awaiting approval",
  monitor: "Live — awaiting kill / scale call",
};

export type OperatorConsoleProps = {
  initialRuns: OperatorRun[];
};

export function OperatorConsole({ initialRuns }: OperatorConsoleProps) {
  const router = useRouter();
  const [runs, setRuns] = React.useState<OperatorRun[]>(initialRuns);
  const [selectedId, setSelectedId] = React.useState<string | null>(initialRuns[0]?.id ?? null);
  const [kickoffOpen, setKickoffOpen] = React.useState(initialRuns.length === 0);

  React.useEffect(() => {
    setRuns(initialRuns);
    // Keep the selection valid as the run set changes (e.g. a run finished).
    setSelectedId((prev) =>
      prev && initialRuns.some((r) => r.id === prev) ? prev : (initialRuns[0]?.id ?? null),
    );
  }, [initialRuns]);

  // New runs + stage transitions: let the server re-query so client name joins
  // and seeded events stay accurate (same approach as PipelineList).
  useRealtimeStream(
    React.useMemo(
      () => [{ table: "pipelines", event: "*" as const, callback: () => router.refresh() }],
      [router],
    ),
  );

  const selected = runs.find((r) => r.id === selectedId) ?? null;

  return (
    <div className="flex flex-col gap-6">
      {/* Kickoff (collapsible) */}
      <section className="rounded-lg border border-border bg-card">
        <button
          type="button"
          className="flex w-full items-center justify-between gap-2 px-4 py-3 text-left"
          aria-expanded={kickoffOpen}
          onClick={() => setKickoffOpen((o) => !o)}
        >
          <span className="flex items-center gap-2 text-sm font-semibold tracking-tight">
            <Bot className="h-4 w-4 text-sky-600 dark:text-sky-400" aria-hidden="true" />
            Hire the operator
          </span>
          {kickoffOpen ? (
            <ChevronUp className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          ) : (
            <ChevronDown className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          )}
        </button>
        {kickoffOpen ? (
          <div className="border-t border-border px-4 py-4">
            <OperatorKickoffForm />
          </div>
        ) : null}
      </section>

      {runs.length === 0 ? (
        <EmptyState
          icon={<Factory className="h-8 w-8" aria-hidden="true" />}
          title="No active operator runs"
          description="Hire the operator above to kick off a run. Active runs appear here with live narration and gate actions."
        />
      ) : (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_24rem]">
          {/* Active runs list */}
          <section aria-label="Active operator runs" className="flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <Gauge className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
              <h2 className="text-sm font-semibold tracking-tight">Active runs</h2>
              <span className="text-xs text-muted-foreground">{runs.length}</span>
            </div>
            <ul className="flex flex-col gap-2" data-testid="operator-runs">
              {runs.map((run) => {
                const gate = GATE_STAGES[run.status];
                const isSelected = run.id === selectedId;
                return (
                  <li key={run.id}>
                    <div
                      data-testid={`operator-run-${run.id}`}
                      className={cn(
                        "flex flex-col gap-2 rounded-lg border bg-card px-3 py-3 transition-colors",
                        isSelected ? "border-primary ring-1 ring-primary/30" : "border-border",
                      )}
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <button
                          type="button"
                          onClick={() => setSelectedId(run.id)}
                          className="min-w-0 flex-1 text-left"
                          aria-pressed={isSelected}
                          aria-label={`Select run ${run.clientName ?? run.id.slice(0, 8)}`}
                        >
                          <span className="block truncate text-sm font-medium">
                            {run.clientName ?? run.id.slice(0, 8)}
                          </span>
                          <span className="text-xs text-muted-foreground">
                            {PIPELINE_STATUS_LABEL[run.status]} ·{" "}
                            {timeSince(run.updated_at ?? run.created_at)}
                          </span>
                        </button>
                        <StatusBadge status={run.status} />
                      </div>

                      {gate ? (
                        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-1.5">
                          <span className="text-xs text-amber-700 dark:text-amber-300">{gate}</span>
                          <Button asChild size="sm" variant="outline" className="h-7">
                            <Link href={`/pipeline/${run.id}` as Route}>Review &amp; decide</Link>
                          </Button>
                        </div>
                      ) : (
                        <div className="flex justify-end">
                          <Button asChild size="sm" variant="ghost" className="h-7">
                            <Link href={`/pipeline/${run.id}` as Route}>Open run</Link>
                          </Button>
                        </div>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>

          {/* Selected run narration */}
          <aside className="flex flex-col gap-3 lg:sticky lg:top-6 lg:self-start">
            {selected ? (
              <>
                <div className="flex items-center justify-between gap-2">
                  <h2 className="flex items-center gap-2 text-sm font-semibold tracking-tight">
                    <Radio className="h-4 w-4 text-sky-600 dark:text-sky-400" aria-hidden="true" />
                    {selected.clientName ?? selected.id.slice(0, 8)}
                  </h2>
                  <Button asChild size="sm" variant="outline" className="h-7">
                    <Link href={`/pipeline/${selected.id}` as Route}>Supervise</Link>
                  </Button>
                </div>
                <OperatorNarration
                  key={selected.id}
                  pipelineId={selected.id}
                  initialEvents={selected.events}
                />
              </>
            ) : null}
          </aside>
        </div>
      )}
    </div>
  );
}
