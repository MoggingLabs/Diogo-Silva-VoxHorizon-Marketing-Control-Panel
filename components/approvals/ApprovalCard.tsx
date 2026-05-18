"use client";

import { AlertCircle, Clock, ShieldAlert, Wallet, Globe, FolderTree } from "lucide-react";

import type { Approval } from "@/lib/approvals/types";
import { summariseArgs } from "@/lib/approvals/highlight";
import { timeSince } from "@/lib/format-time";
import { cn } from "@/lib/utils";

/**
 * Compact row representing one approval. Used in:
 *   - the sidebar queue dropdown
 *   - the audit list on `/approvals`
 *
 * The component is presentational — it just renders. Selection/keyboard
 * navigation lives in the parent.
 */
export type ApprovalCardProps = {
  approval: Approval;
  /** Highlight the card when it's the "current" selection. */
  active?: boolean;
  /** Fired when the operator clicks the body (e.g. to open the modal). */
  onSelect?: (approval: Approval) => void;
  className?: string;
};

const RISK_ICON = {
  spend: Wallet,
  "external-write": Globe,
  filesystem: FolderTree,
  unknown: ShieldAlert,
} as const;

const RISK_CLASS = {
  spend: "text-red-600 dark:text-red-300",
  "external-write": "text-amber-600 dark:text-amber-300",
  filesystem: "text-yellow-600 dark:text-yellow-200",
  unknown: "text-muted-foreground",
} as const;

function riskKey(risk: Approval["risk_class"]): keyof typeof RISK_ICON {
  if (risk === "spend" || risk === "external-write" || risk === "filesystem") return risk;
  return "unknown";
}

export function ApprovalCard({ approval, active, onSelect, className }: ApprovalCardProps) {
  const risk = riskKey(approval.risk_class);
  const Icon = RISK_ICON[risk];
  const summary = summariseArgs(approval.tool_args);
  const skill = approval.context?.skill_name;

  return (
    <button
      type="button"
      onClick={() => onSelect?.(approval)}
      data-testid={`approval-card-${approval.id}`}
      data-active={active ? "true" : undefined}
      className={cn(
        "flex w-full flex-col gap-1 rounded-md border px-3 py-2 text-left transition-colors",
        active
          ? "border-primary bg-primary/5"
          : "border-border bg-card hover:border-accent hover:bg-accent/40",
        className,
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-2">
          <Icon
            className={cn("h-4 w-4 shrink-0", RISK_CLASS[risk])}
            aria-hidden="true"
            data-testid="risk-icon"
          />
          <span className="truncate text-sm font-medium text-foreground">{approval.tool_name}</span>
        </span>
        <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
          <Clock className="h-3 w-3" aria-hidden="true" />
          <span data-testid="time-since">{timeSince(approval.requested_at)}</span>
        </span>
      </div>
      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span className="truncate">
          {skill ? (
            <span>{skill}</span>
          ) : (
            <span className="italic">{approval.ekko_session_id}</span>
          )}
        </span>
        <span className="flex shrink-0 items-center gap-1">
          {summary.kinds.money > 0 ? (
            <span className="inline-flex items-center gap-0.5 rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-medium text-red-700 dark:bg-red-900/40 dark:text-red-200">
              <AlertCircle className="h-3 w-3" aria-hidden="true" />${summary.kinds.money}
            </span>
          ) : null}
          {summary.kinds.path > 0 ? (
            <span className="inline-flex items-center gap-0.5 rounded bg-yellow-100 px-1.5 py-0.5 text-[10px] font-medium text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-100">
              {summary.kinds.path} path
            </span>
          ) : null}
          {summary.kinds.url > 0 ? (
            <span className="inline-flex items-center gap-0.5 rounded bg-sky-100 px-1.5 py-0.5 text-[10px] font-medium text-sky-800 dark:bg-sky-900/40 dark:text-sky-100">
              {summary.kinds.url} url
            </span>
          ) : null}
        </span>
      </div>
    </button>
  );
}
