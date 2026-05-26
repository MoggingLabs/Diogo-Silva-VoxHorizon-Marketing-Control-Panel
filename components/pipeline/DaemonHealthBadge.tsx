"use client";

import * as React from "react";
import { ChevronDown, ChevronUp, Server } from "lucide-react";

import { StatusBadge } from "@/components/ui/StatusBadge";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useDaemonHealth } from "@/hooks/useDaemonHealth";
import type { DaemonFreshness, WorkItemConsumer } from "@/lib/work-queue/types";
import { cn } from "@/lib/utils";

/**
 * Silent-failure PR-2a: the canonical "is the operator daemon up?" badge.
 *
 * Reads via `useDaemonHealth` (which hits `/api/operator/daemon-health` and
 * subscribes to `work_item_consumers`). Renders the colored status pill +
 * a tooltip carrying the image tag / hostname, and a disclosure for the
 * full `startup_check` JSON. When the daemon writes `status='down'` with
 * `startup_check.auth='expired'` (the exact bug class this PR is built to
 * catch), the red pill + "Auth: expired" line render front-and-center.
 *
 * Mounted once at the top of the OperatorConsole and the pipeline cockpit
 * (the latter via the WorkItemPanel) so the operator always sees the daemon
 * health alongside whatever they're driving.
 */

const FRESHNESS_TO_BADGE: Record<DaemonFreshness, string> = {
  live: "live",
  starting: "starting",
  stale: "degraded",
  down: "down",
};

const FRESHNESS_LABEL: Record<DaemonFreshness, string> = {
  live: "Operator daemon: live",
  starting: "Operator daemon: starting",
  stale: "Operator daemon: heartbeat stale",
  down: "Operator daemon: DOWN",
};

export type DaemonHealthBadgeProps = {
  /** SSR-seeded consumer row (skips the first fetch). */
  initialConsumer?: WorkItemConsumer | null;
  /** Override the fetch URL (tests). */
  url?: string;
  /** Optional outer class. */
  className?: string;
};

export function DaemonHealthBadge({ initialConsumer, url, className }: DaemonHealthBadgeProps) {
  const { consumer, freshness } = useDaemonHealth({ initialConsumer, url });
  const [open, setOpen] = React.useState(false);

  const badgeStatus = FRESHNESS_TO_BADGE[freshness];
  const label = FRESHNESS_LABEL[freshness];
  const startupCheck = (consumer?.startup_check ?? null) as Record<string, unknown> | null;

  const failedChecks = React.useMemo(() => {
    if (!startupCheck) return [] as { key: string; value: string }[];
    return Object.entries(startupCheck)
      .filter(([, v]) => typeof v === "string" && v !== "ok")
      .map(([key, value]) => ({ key, value: String(value) }));
  }, [startupCheck]);

  const showStartupReason = freshness === "down" && failedChecks.length > 0;

  return (
    <div
      className={cn("flex flex-col gap-1.5", className)}
      data-testid="daemon-health-badge"
      data-freshness={freshness}
    >
      <div className="flex flex-wrap items-center gap-2">
        <TooltipProvider delayDuration={150}>
          <Tooltip>
            <TooltipTrigger asChild>
              <span aria-label={label} className="inline-flex">
                <StatusBadge status={badgeStatus} label={label} />
              </span>
            </TooltipTrigger>
            <TooltipContent>
              <div className="flex flex-col gap-1 text-xs">
                <span className="font-medium">{consumer?.id ?? "no daemon"}</span>
                {consumer?.image_tag ? <span>image: {consumer.image_tag}</span> : null}
                {consumer?.hostname ? <span>host: {consumer.hostname}</span> : null}
                {consumer?.last_seen_at ? <span>last seen: {consumer.last_seen_at}</span> : null}
              </div>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>

        {/* Down-with-explanation chips. Loud, inline, no hover. */}
        {showStartupReason
          ? failedChecks.map((c) => (
              <span
                key={c.key}
                data-testid={`daemon-startup-check-${c.key}`}
                className="inline-flex items-center gap-1 rounded-full border border-destructive/40 bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive"
              >
                <Server className="h-3 w-3" aria-hidden="true" />
                {c.key}: {c.value}
              </span>
            ))
          : null}
      </div>

      {/* Disclosure for the full startup_check JSON — useful in deep triage. */}
      {startupCheck ? (
        <div>
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            {open ? (
              <ChevronUp className="h-3 w-3" aria-hidden="true" />
            ) : (
              <ChevronDown className="h-3 w-3" aria-hidden="true" />
            )}
            details
          </button>
          {open ? (
            <pre
              data-testid="daemon-startup-check-json"
              className="mt-1 max-w-md overflow-auto rounded border border-border bg-muted px-2 py-1 text-[11px] text-muted-foreground"
            >
              {JSON.stringify(startupCheck, null, 2)}
            </pre>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
