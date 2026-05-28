"use client";

import * as React from "react";
import { ChevronDown, ChevronUp, Loader2, RefreshCcw } from "lucide-react";

import { CancelPipelineButton } from "@/components/pipeline/CancelPipelineButton";
import { DaemonHealthBadge } from "@/components/pipeline/DaemonHealthBadge";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useActiveWorkItem } from "@/hooks/useActiveWorkItem";
import type { PipelineDispatchState, WorkItem, WorkItemConsumer } from "@/lib/work-queue/types";
import { WORK_ITEM_KIND_LABEL } from "@/lib/work-queue/types";
import { cn } from "@/lib/utils";

/**
 * Silent-failure PR-2a: the canonical "what is the dispatcher doing right
 * now?" surface.
 *
 * Replaces the 11 stage-specific "Hang tight" locked-state blocks (PR-3 swaps
 * them in). This PR ships the panel sitting next to the legacy blocks so the
 * dispatch state has a live home before the cutover.
 *
 * Renders:
 *   - The kind-agnostic header (label + description from WORK_ITEM_KIND_LABEL).
 *   - The status pill (7 work_item_status values).
 *   - Freshness from `heartbeat_at` when running.
 *   - `error_kind` + truncated `error_detail.msg` on terminal failure.
 *   - The retry chain (collapsible) via `parent_work_item_id`.
 *   - Two recovery actions: Redispatch (DISABLED — PR-2b enables it) +
 *     Cancel (reuses CancelPipelineButton verbatim).
 *   - A DaemonHealthBadge so the operator sees the daemon health right next
 *     to the work it's draining.
 */

const TERMINAL: ReadonlySet<WorkItem["status"]> = new Set([
  "completed",
  "failed",
  "timed_out",
  "cancelled",
]);

const HEARTBEAT_STALE_THRESHOLD_S = 60;

export type WorkItemPanelProps = {
  pipelineId: string;
  /**
   * SSR-seeded pipeline dispatch state from
   * `/api/pipelines/[id]/work-state`. Skips the first client fetch.
   */
  initialState?: PipelineDispatchState;
  /** Override the fetch URL (tests). */
  url?: string;
  /** Override the daemon-health fetch URL (tests). */
  daemonHealthUrl?: string;
  /** SSR-seeded daemon consumer for the embedded health badge. */
  initialDaemonConsumer?: WorkItemConsumer | null;
  /** Optional outer class. */
  className?: string;
};

export function WorkItemPanel({
  pipelineId,
  initialState,
  url,
  daemonHealthUrl,
  initialDaemonConsumer,
  className,
}: WorkItemPanelProps) {
  const { activeWorkItem, isLoading, error } = useActiveWorkItem(pipelineId, {
    initialState,
    url,
  });

  if (isLoading && !activeWorkItem) {
    return (
      <section
        className={cn(
          "flex items-center gap-2 rounded-lg border border-border bg-card px-4 py-3 text-sm text-muted-foreground",
          className,
        )}
        data-testid="work-item-panel"
        data-state="loading"
      >
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        Loading dispatch state…
      </section>
    );
  }

  if (error) {
    return (
      <section
        className={cn(
          "flex items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive",
          className,
        )}
        role="alert"
        data-testid="work-item-panel"
        data-state="error"
      >
        Failed to load dispatch state: {error}
      </section>
    );
  }

  return (
    <section
      className={cn(
        "flex flex-col gap-3 rounded-lg border border-border bg-card p-4 text-sm",
        className,
      )}
      data-testid="work-item-panel"
      data-state={activeWorkItem?.status ?? "idle"}
    >
      <HeaderRow workItem={activeWorkItem} />
      <DaemonHealthBadge initialConsumer={initialDaemonConsumer} url={daemonHealthUrl} />
      {activeWorkItem ? (
        <>
          <FreshnessRow workItem={activeWorkItem} />
          {activeWorkItem.status === "failed" || activeWorkItem.status === "timed_out" ? (
            <FailureDetail workItem={activeWorkItem} />
          ) : null}
          <RetryChain workItem={activeWorkItem} />
          <ActionRow workItem={activeWorkItem} pipelineId={pipelineId} />
        </>
      ) : (
        <ActionRow workItem={null} pipelineId={pipelineId} />
      )}
    </section>
  );
}

/**
 * Silent-failure PR-5: an auto-hiding wrapper that mounts the WorkItemPanel at
 * the bottom of the ideation/review/generation stages.
 *
 * The happy path on those stages has NO active work_item -- the dispatcher only
 * runs during the operator-driven configuration kickoff and on recovery. So the
 * slot renders NOTHING (returns null) unless there is an active work_item, which
 * keeps the stage layout unchanged for the common case.
 *
 * Crucially, when there is no active work_item the slot does NOT mount
 * `WorkItemPanel` at all, so `useActiveWorkItem` never runs: no work-state
 * fetch, no realtime channel. This is the fix for the PR-3 stall, where the
 * panel's hook subscribed + fetched unconditionally on every stage mount and
 * stalled the review->generation flow. The seed comes from the page-level
 * server component (`v_pipeline_dispatch_state`); when a work_item appears the
 * page re-seeds via `router.refresh()` and the slot flips on with live data.
 */
export type WorkItemPanelSlotProps = {
  pipelineId: string;
  /** SSR-seeded active work_item for this pipeline (null when the dispatcher is idle). */
  initialWorkItem: WorkItem | null;
  /** Override the fetch URL (tests). */
  url?: string;
  /** Optional outer class forwarded to the panel. */
  className?: string;
};

export function WorkItemPanelSlot({
  pipelineId,
  initialWorkItem,
  url,
  className,
}: WorkItemPanelSlotProps) {
  // No active work_item -> render nothing AND don't mount the panel (so the
  // hook + its realtime channel never start). The common stage render stays
  // byte-for-byte unchanged.
  if (!initialWorkItem) return null;

  const initialState: PipelineDispatchState = {
    pipelineId,
    derivedStatus: "configuration",
    activeWorkItem: initialWorkItem,
    recentEvents: [],
    operatorDaemon: null,
  };

  return (
    <section
      data-testid="work-item-panel-slot"
      aria-label="Dispatcher status"
      className={cn("mt-2 border-t border-border pt-4", className)}
    >
      <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Dispatcher status
      </p>
      <WorkItemPanel pipelineId={pipelineId} initialState={initialState} url={url} />
    </section>
  );
}

function HeaderRow({ workItem }: { workItem: WorkItem | null }) {
  if (!workItem) {
    return (
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-col">
          <span className="text-base font-semibold tracking-tight">Dispatcher idle</span>
          <span className="text-xs text-muted-foreground">
            No work_item is queued or running for this pipeline.
          </span>
        </div>
        <StatusBadge status="no-row" />
      </header>
    );
  }
  const kindEntry = WORK_ITEM_KIND_LABEL[workItem.kind] ?? WORK_ITEM_KIND_LABEL.other;
  return (
    <header className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex min-w-0 flex-col">
        <span className="truncate text-base font-semibold tracking-tight">{kindEntry.label}</span>
        <span className="text-xs text-muted-foreground">{kindEntry.description}</span>
      </div>
      <StatusBadge status={workItem.status} />
    </header>
  );
}

function FreshnessRow({ workItem }: { workItem: WorkItem }) {
  if (workItem.status !== "claimed" && workItem.status !== "running") return null;
  const heartbeat = workItem.heartbeat_at ? Date.parse(workItem.heartbeat_at) : null;
  const ageS =
    heartbeat !== null && !Number.isNaN(heartbeat) ? (Date.now() - heartbeat) / 1000 : null;
  const stale = ageS !== null && ageS > HEARTBEAT_STALE_THRESHOLD_S;
  return (
    <div
      data-testid="work-item-freshness"
      data-stale={stale ? "yes" : "no"}
      className={cn(
        "flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-xs",
        stale
          ? "border-warning/40 bg-warning/10 text-warning"
          : "border-border bg-muted/40 text-muted-foreground",
      )}
    >
      <span>
        attempt {workItem.attempt}
        {workItem.claimed_by ? ` · claimed by ${workItem.claimed_by}` : ""}
      </span>
      {workItem.heartbeat_at ? (
        <span>
          last heartbeat: {workItem.heartbeat_at}
          {ageS !== null ? ` (~${Math.round(ageS)}s ago)` : ""}
        </span>
      ) : (
        <span>no heartbeat yet</span>
      )}
    </div>
  );
}

function FailureDetail({ workItem }: { workItem: WorkItem }) {
  const detail = (workItem.error_detail ?? null) as Record<string, unknown> | null;
  const rawMsg = detail && typeof detail.msg === "string" ? detail.msg : null;
  const truncated = rawMsg && rawMsg.length > 240 ? rawMsg.slice(0, 240) + "…" : rawMsg;
  return (
    <div
      role="alert"
      data-testid="work-item-failure"
      className="flex flex-col gap-1 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
    >
      <span className="font-medium">
        {workItem.error_kind ?? "unknown error"} (attempt {workItem.attempt})
      </span>
      {truncated ? <p className="break-words">{truncated}</p> : null}
    </div>
  );
}

function RetryChain({ workItem }: { workItem: WorkItem }) {
  const [open, setOpen] = React.useState(false);
  if (!workItem.parent_work_item_id) return null;
  return (
    <div data-testid="work-item-retry-chain">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        {open ? (
          <ChevronUp className="h-3 w-3" aria-hidden="true" />
        ) : (
          <ChevronDown className="h-3 w-3" aria-hidden="true" />
        )}
        retry chain
      </button>
      {open ? (
        <div className="mt-1 rounded border border-border bg-muted px-2 py-1 text-[11px] text-muted-foreground">
          retried from parent work_item: <code>{workItem.parent_work_item_id}</code> (attempt{" "}
          {workItem.attempt})
        </div>
      ) : null}
    </div>
  );
}

function ActionRow({ workItem, pipelineId }: { workItem: WorkItem | null; pipelineId: string }) {
  const canRedispatch = workItem !== null && TERMINAL.has(workItem.status);
  // The redispatch route ships in PR-2b. Always render the button disabled here
  // (so the surface signals the recovery option) with a tooltip pointing at the
  // follow-up PR.
  return (
    <footer className="flex flex-wrap items-center justify-end gap-2">
      <TooltipProvider delayDuration={200}>
        <Tooltip>
          <TooltipTrigger asChild>
            {/* The disabled button is wrapped in a span so the tooltip still
                fires while pointer-events on the button itself are off. */}
            <span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled
                aria-disabled
                aria-label="Redispatch (coming in PR-2b)"
                className="gap-1.5"
                data-testid="work-item-redispatch"
                data-can-redispatch={canRedispatch ? "yes" : "no"}
              >
                <RefreshCcw className="h-3.5 w-3.5" aria-hidden="true" />
                Redispatch
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent>Redispatch is implemented in PR-2b.</TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <CancelPipelineButton pipelineId={pipelineId} />
    </footer>
  );
}
