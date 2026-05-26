"use client";

import { useMemo } from "react";
import { AlertTriangle, Bot, CircleDollarSign, Info } from "lucide-react";

import { usePipelineEvents } from "@/hooks/usePipelineEvents";
import { timeSince } from "@/lib/format-time";
import { buildNarration, type NarrationLine, type NarrationTone } from "@/lib/operator/narration";
import type { PipelineEvent } from "@/lib/pipeline/types";
import { cn } from "@/lib/utils";

/**
 * Operator narration view for the supervision cockpit.
 *
 * Renders the operator's progress in plain language alongside the stage UI.
 * It reuses the existing realtime plumbing — `usePipelineEvents` seeds from
 * the server-fetched snapshot and folds in new rows via the SSE relay — and
 * translates the raw `pipeline_events` into manager-facing narration with
 * `buildNarration`. No new transport, and no worker change required.
 *
 * The technical render-task list still lives in `StageGeneration`; this feed
 * is the human story (brief authored → concepts ready → finals rendered →
 * spend recorded), so a manager can supervise without reading event JSON.
 */
export type OperatorNarrationProps = {
  pipelineId: string;
  initialEvents: PipelineEvent[];
  className?: string;
};

const TONE_DOT: Record<NarrationTone, string> = {
  operator: "text-info",
  system: "text-muted-foreground",
  cost: "text-success",
  error: "text-destructive",
};

function ToneIcon({ tone }: { tone: NarrationTone }) {
  const className = cn("h-4 w-4 shrink-0", TONE_DOT[tone]);
  if (tone === "error") return <AlertTriangle aria-hidden="true" className={className} />;
  if (tone === "cost") return <CircleDollarSign aria-hidden="true" className={className} />;
  if (tone === "operator") return <Bot aria-hidden="true" className={className} />;
  return <Info aria-hidden="true" className={className} />;
}

export function OperatorNarration({
  pipelineId,
  initialEvents,
  className,
}: OperatorNarrationProps) {
  const events = usePipelineEvents(pipelineId, initialEvents);
  // Newest first so the latest operator step is at the top of the panel.
  const lines = useMemo<NarrationLine[]>(() => buildNarration(events).reverse(), [events]);

  return (
    <section
      aria-label="Operator narration"
      data-testid="operator-narration"
      className={cn(
        "flex flex-col gap-3 rounded-lg border border-border bg-card px-4 py-4 sm:px-5 sm:py-5",
        className,
      )}
    >
      <div className="flex items-center gap-2">
        <Bot aria-hidden="true" className="h-4 w-4 text-info" />
        <h2 className="text-sm font-semibold tracking-tight">Operator</h2>
        <span className="text-xs text-muted-foreground">live narration</span>
      </div>

      {lines.length === 0 ? (
        <p
          className="rounded-md border border-dashed bg-muted/30 px-3 py-6 text-center text-sm text-muted-foreground"
          data-testid="operator-narration-empty"
        >
          The operator hasn&apos;t reported anything yet. Updates appear here as it works.
        </p>
      ) : (
        <ol className="flex flex-col gap-2.5">
          {lines.map((line) => (
            <li key={line.id} className="flex items-start gap-2.5">
              <span className="mt-0.5">
                <ToneIcon tone={line.tone} />
              </span>
              <div className="flex flex-1 flex-col gap-0.5">
                <p className="text-sm leading-snug text-foreground">{line.text}</p>
                <time
                  dateTime={line.at}
                  className="text-[11px] uppercase tracking-wide text-muted-foreground"
                >
                  {timeSince(line.at)}
                </time>
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
