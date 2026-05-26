"use client";

import { CheckCircle2, XCircle, AlertTriangle, Circle, Ban } from "lucide-react";

import type { Approval, ApprovalDecision } from "@/lib/approvals/types";
import { formatDate, timeSince } from "@/lib/format-time";
import { cn } from "@/lib/utils";

/**
 * Vertical list of past approval decisions for a single Ekko session
 * (or for the global audit page). Each row shows:
 *   - decision badge (approved / rejected / approved_with_caveat)
 *   - tool name + relative timestamp
 *   - decision notes when present
 *
 * Order is newest-first (caller is expected to pre-sort if not already so).
 */
export type ApprovalAuditTrailProps = {
  approvals: Approval[];
  /** Optional emptyState override. */
  emptyMessage?: string;
  className?: string;
};

const DECISION_ICON: Record<ApprovalDecision, typeof CheckCircle2> = {
  approved: CheckCircle2,
  rejected: XCircle,
  approved_with_caveat: AlertTriangle,
};

const DECISION_LABEL: Record<ApprovalDecision, string> = {
  approved: "Approved",
  rejected: "Rejected",
  approved_with_caveat: "Approved (caveat)",
};

const DECISION_CLASS: Record<ApprovalDecision, string> = {
  approved: "text-success",
  rejected: "text-destructive",
  approved_with_caveat: "text-warning",
};

export function ApprovalAuditTrail({
  approvals,
  emptyMessage = "No prior decisions in this session.",
  className,
}: ApprovalAuditTrailProps) {
  if (approvals.length === 0) {
    return (
      <p
        className={cn("text-sm italic text-muted-foreground", className)}
        data-testid="audit-empty"
      >
        {emptyMessage}
      </p>
    );
  }
  return (
    <ol
      className={cn("flex flex-col gap-2", className)}
      data-testid="audit-trail"
      aria-label="Past approval decisions"
    >
      {approvals.map((approval) => (
        <Row key={approval.id} approval={approval} />
      ))}
    </ol>
  );
}

function Row({ approval }: { approval: Approval }) {
  const decision = approval.decision;
  const Icon = decision ? DECISION_ICON[decision] : approval.status === "cancelled" ? Ban : Circle;
  const label =
    decision !== null
      ? DECISION_LABEL[decision]
      : approval.status === "cancelled"
        ? "Cancelled"
        : approval.status === "expired"
          ? "Expired"
          : "Pending";
  const iconClass = decision
    ? DECISION_CLASS[decision]
    : approval.status === "cancelled" || approval.status === "expired"
      ? "text-muted-foreground"
      : "text-muted-foreground";
  return (
    <li
      data-testid={`audit-row-${approval.id}`}
      className="flex items-start gap-3 rounded-md border border-border bg-card px-3 py-2 text-sm"
    >
      <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", iconClass)} aria-hidden="true" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-center justify-between gap-2 text-xs">
          <span className="font-medium text-foreground">
            {label}: <span className="font-mono">{approval.tool_name}</span>
          </span>
          <span className="text-muted-foreground" title={formatDate(approval.decided_at) ?? ""}>
            {timeSince(approval.decided_at ?? approval.requested_at)}
          </span>
        </div>
        {approval.decision_notes ? (
          <p className="text-xs text-muted-foreground">{approval.decision_notes}</p>
        ) : null}
        {approval.cache_for_session ? (
          <p className="text-[11px] text-muted-foreground" data-testid="cache-flag">
            Remembered for this session
          </p>
        ) : null}
      </div>
    </li>
  );
}
