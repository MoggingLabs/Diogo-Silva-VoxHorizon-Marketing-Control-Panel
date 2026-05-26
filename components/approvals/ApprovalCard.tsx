"use client";

import { useCallback, useState } from "react";
import {
  AlertCircle,
  Check,
  Clock,
  Loader2,
  ShieldAlert,
  Wallet,
  Globe,
  FolderTree,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import type { Approval, ApprovalDecision } from "@/lib/approvals/types";
import { approvalTitle, describeApproval } from "@/lib/approvals/describe";
import { summariseArgs } from "@/lib/approvals/highlight";
import { timeSince } from "@/lib/format-time";
import { cn } from "@/lib/utils";

/**
 * Compact row representing one approval. Used in the sidebar queue dropdown.
 *
 * Renders the "Client — Purpose" title plus a short description. When the
 * approval is still `pending` it also shows inline Approve / Reject buttons
 * that POST the decision directly (same body shape the modal sends) without
 * opening the full modal. Clicking the body still opens the modal via
 * `onSelect`.
 */
export type ApprovalCardProps = {
  approval: Approval;
  /** Highlight the card when it's the "current" selection. */
  active?: boolean;
  /** Fired when the operator clicks the body (e.g. to open the modal). */
  onSelect?: (approval: Approval) => void;
  /** Fired after a successful inline decision so the parent can revalidate. */
  onDecided?: (approval: Approval, decision: ApprovalDecision) => void;
  className?: string;
};

const RISK_ICON = {
  spend: Wallet,
  "external-write": Globe,
  filesystem: FolderTree,
  unknown: ShieldAlert,
} as const;

const RISK_CLASS = {
  spend: "text-destructive",
  "external-write": "text-warning",
  filesystem: "text-warning/80",
  unknown: "text-muted-foreground",
} as const;

function riskKey(risk: Approval["risk_class"]): keyof typeof RISK_ICON {
  if (risk === "spend" || risk === "external-write" || risk === "filesystem") return risk;
  return "unknown";
}

/**
 * POST a decision to the server. Mirrors the body the modal flow sends:
 * `{ decision, notes?, cache_for_session }`.
 */
async function postDecision(
  approvalId: string,
  decision: ApprovalDecision,
  notes?: string,
): Promise<void> {
  const res = await fetch(`/api/approvals/${approvalId}/decision`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      decision,
      notes,
      cache_for_session: false,
    }),
  });
  if (!res.ok) {
    throw new Error(`Decision failed: HTTP ${res.status}`);
  }
}

export function ApprovalCard({
  approval,
  active,
  onSelect,
  onDecided,
  className,
}: ApprovalCardProps) {
  const risk = riskKey(approval.risk_class);
  const Icon = RISK_ICON[risk];
  const summary = summariseArgs(approval.tool_args);
  const title = approvalTitle(approval);
  const { detail } = describeApproval(approval);
  const isPending = approval.status === "pending";

  const [submitting, setSubmitting] = useState<ApprovalDecision | null>(null);
  const [error, setError] = useState<string | null>(null);

  const decide = useCallback(
    async (decision: ApprovalDecision) => {
      if (submitting) return;
      setSubmitting(decision);
      setError(null);
      try {
        await postDecision(
          approval.id,
          decision,
          decision === "rejected" ? "Rejected from queue" : undefined,
        );
        onDecided?.(approval, decision);
      } catch (e) {
        setSubmitting(null);
        setError(e instanceof Error ? e.message : "Decision failed");
      }
    },
    [approval, onDecided, submitting],
  );

  return (
    <div
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
      <button
        type="button"
        onClick={() => onSelect?.(approval)}
        data-testid={`approval-card-body-${approval.id}`}
        className="flex w-full flex-col gap-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <div className="flex items-center justify-between gap-2">
          <span className="flex min-w-0 items-center gap-2">
            <Icon
              className={cn("h-4 w-4 shrink-0", RISK_CLASS[risk])}
              aria-hidden="true"
              data-testid="risk-icon"
            />
            <span className="truncate text-sm font-medium text-foreground" data-testid="card-title">
              {title}
            </span>
          </span>
          <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
            <Clock className="h-3 w-3" aria-hidden="true" />
            <span data-testid="time-since">{timeSince(approval.requested_at)}</span>
          </span>
        </div>
        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <span className="truncate" data-testid="card-detail">
            {detail}
          </span>
          <span className="flex shrink-0 items-center gap-1">
            {summary.kinds.money > 0 ? (
              <span className="inline-flex items-center gap-0.5 rounded bg-destructive/15 px-1.5 py-0.5 text-[10px] font-medium text-destructive ring-1 ring-inset ring-destructive/30">
                <AlertCircle className="h-3 w-3" aria-hidden="true" />${summary.kinds.money}
              </span>
            ) : null}
            {summary.kinds.path > 0 ? (
              <span className="inline-flex items-center gap-0.5 rounded bg-warning/15 px-1.5 py-0.5 text-[10px] font-medium text-warning ring-1 ring-inset ring-warning/30">
                {summary.kinds.path} path
              </span>
            ) : null}
            {summary.kinds.url > 0 ? (
              <span className="inline-flex items-center gap-0.5 rounded bg-info/15 px-1.5 py-0.5 text-[10px] font-medium text-info ring-1 ring-inset ring-info/30">
                {summary.kinds.url} url
              </span>
            ) : null}
          </span>
        </div>
      </button>

      {isPending ? (
        <div className="mt-1 flex items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="default"
            data-testid={`approval-card-approve-${approval.id}`}
            onClick={() => void decide("approved")}
            disabled={submitting !== null}
            className="h-7 flex-1 px-2 text-xs"
          >
            {submitting === "approved" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <Check className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            Approve
          </Button>
          <Button
            type="button"
            size="sm"
            variant="destructive"
            data-testid={`approval-card-reject-${approval.id}`}
            onClick={() => void decide("rejected")}
            disabled={submitting !== null}
            className="h-7 flex-1 px-2 text-xs"
          >
            {submitting === "rejected" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            Reject
          </Button>
        </div>
      ) : null}

      {error ? (
        <p
          role="alert"
          data-testid={`approval-card-error-${approval.id}`}
          className="text-xs text-destructive"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}
