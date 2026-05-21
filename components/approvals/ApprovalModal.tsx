"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, X, Clock4, AlertTriangle, Bookmark } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { Approval, ApprovalDecision } from "@/lib/approvals/types";
import { approvalTitle } from "@/lib/approvals/describe";
import { formatDate } from "@/lib/format-time";
import { cn } from "@/lib/utils";

import { ApprovalArgsDiff } from "./ApprovalArgsDiff";
import { ApprovalAuditTrail } from "./ApprovalAuditTrail";

/**
 * Full-screen modal for a single pending approval.
 *
 * Behaviour:
 *   - Renders on top of the page via Radix's Dialog (focus-trapped, ESC
 *     closes). We override the default content sizing for a wider modal.
 *   - Keyboard shortcuts when the modal is open and no input has focus:
 *       A → approve
 *       R → reject
 *       S → approve + remember for session
 *       Escape → close (deferred — no decision made)
 *   - Notes box is editable; the value is sent with every decision.
 *   - The Submit buttons disable while a decision is in flight.
 *
 * Decision dispatch:
 *   The parent supplies an `onDecide(decision, opts)` callback. The modal
 *   does NOT POST directly — that keeps it test-friendly and lets the
 *   queue component handle optimistic UI / refresh.
 */
export type ApprovalModalProps = {
  approval: Approval | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Past decisions for the session — populates the audit trail panel. */
  pastDecisions?: Approval[];
  /** Submit the decision; the parent does the POST. Returns a promise so the modal can show a pending state. */
  onDecide: (
    decision: ApprovalDecision,
    opts: { notes?: string; cache_for_session: boolean },
  ) => Promise<void> | void;
};

const KEY_TO_INTENT: Record<string, { decision: ApprovalDecision; cache: boolean }> = {
  a: { decision: "approved", cache: false },
  r: { decision: "rejected", cache: false },
  s: { decision: "approved", cache: true },
};

/**
 * Returns true if the currently-focused element is an editable target — we
 * skip keyboard shortcuts in that case so the operator can type in the notes
 * box without firing a decision.
 */
function isInputFocused(): boolean {
  if (typeof document === "undefined") return false;
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName.toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return true;
  if ((el as HTMLElement).isContentEditable) return true;
  return false;
}

export function ApprovalModal({
  approval,
  open,
  onOpenChange,
  pastDecisions = [],
  onDecide,
}: ApprovalModalProps) {
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Reset notes when the approval id changes so the operator's last text
  // doesn't bleed across approvals.
  useEffect(() => {
    setNotes("");
    setSubmitting(false);
  }, [approval?.id]);

  // Keep state in refs so the keydown handler reads the latest values
  // without restarting the effect on every keystroke or every submit flip.
  const submittingRef = useRef(false);
  submittingRef.current = submitting;
  const notesRef = useRef("");
  notesRef.current = notes;
  const approvalRef = useRef(approval);
  approvalRef.current = approval;
  const onDecideRef = useRef(onDecide);
  onDecideRef.current = onDecide;

  const submit = useCallback(async (decision: ApprovalDecision, opts: { cache: boolean }) => {
    if (!approvalRef.current) return;
    if (submittingRef.current) return;
    setSubmitting(true);
    try {
      await onDecideRef.current(decision, {
        notes: notesRef.current.trim() || undefined,
        cache_for_session: opts.cache,
      });
    } finally {
      setSubmitting(false);
    }
  }, []);

  // Keyboard shortcuts — only attached when the modal is open. We use refs
  // for the live values so this effect runs once per `open` change, not on
  // every state update.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (!approvalRef.current) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isInputFocused()) return;
      const intent = KEY_TO_INTENT[e.key.toLowerCase()];
      if (!intent) return;
      e.preventDefault();
      void submit(intent.decision, { cache: intent.cache });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, submit]);

  // Compute risk class label safely (the DB column is free-text on read).
  const riskLabel = useMemo(() => {
    const r = approval?.risk_class;
    if (!r) return "unknown";
    return r;
  }, [approval]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[90vh] w-[min(960px,92vw)] max-w-none overflow-y-auto"
        data-testid="approval-modal"
        onOpenAutoFocus={(e) => {
          // Don't auto-focus the textarea — the operator's first action is
          // usually the keyboard shortcut (A/R/S), and a focused textarea
          // captures those.
          e.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-amber-500" aria-hidden="true" />
            {approval ? approvalTitle(approval) : "Tool-call approval required"}
          </DialogTitle>
          <DialogDescription>
            Review the call before allowing Hermes / Ekko to proceed.
          </DialogDescription>
        </DialogHeader>

        {approval ? (
          <div className="flex flex-col gap-4">
            <section className="rounded-md border border-border bg-muted/30 px-3 py-2 text-sm">
              <dl className="grid grid-cols-2 gap-x-4 gap-y-1">
                <dt className="text-muted-foreground">Tool</dt>
                <dd className="font-mono">{approval.tool_name}</dd>
                <dt className="text-muted-foreground">Risk class</dt>
                <dd className="capitalize">{riskLabel}</dd>
                <dt className="text-muted-foreground">Session</dt>
                <dd className="font-mono text-xs">{approval.ekko_session_id}</dd>
                {approval.context?.skill_name ? (
                  <>
                    <dt className="text-muted-foreground">Skill</dt>
                    <dd>{approval.context.skill_name}</dd>
                  </>
                ) : null}
                {typeof approval.context?.estimated_cost === "number" ? (
                  <>
                    <dt className="text-muted-foreground">Estimated cost</dt>
                    <dd>${approval.context.estimated_cost.toFixed(2)}</dd>
                  </>
                ) : null}
                <dt className="text-muted-foreground">Requested</dt>
                <dd>{formatDate(approval.requested_at)}</dd>
                <dt className="text-muted-foreground">Expires</dt>
                <dd className="flex items-center gap-1">
                  <Clock4 className="h-3 w-3" aria-hidden="true" />
                  {formatDate(approval.expires_at)}
                </dd>
              </dl>
            </section>

            <section>
              <h3 className="mb-1 text-sm font-medium">Arguments</h3>
              <ApprovalArgsDiff args={approval.tool_args} />
            </section>

            <section>
              <label
                htmlFor="approval-notes"
                className="mb-1 block text-sm font-medium text-foreground"
              >
                Notes (optional)
              </label>
              <textarea
                id="approval-notes"
                data-testid="approval-notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Why are you approving / rejecting?"
                className="min-h-[64px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </section>

            {pastDecisions.length > 0 ? (
              <section>
                <h3 className="mb-2 text-sm font-medium">Past decisions in this session</h3>
                <ApprovalAuditTrail approvals={pastDecisions} />
              </section>
            ) : null}
          </div>
        ) : (
          <p className="text-sm italic text-muted-foreground" data-testid="modal-empty">
            No approval selected.
          </p>
        )}

        <DialogFooter className="flex flex-col gap-2 sm:flex-row">
          <Button
            type="button"
            variant="destructive"
            data-testid="reject-button"
            onClick={() => void submit("rejected", { cache: false })}
            disabled={!approval || submitting}
            className={cn("sm:order-1")}
          >
            <X className="h-4 w-4" />
            Reject (R)
          </Button>
          <Button
            type="button"
            variant="default"
            data-testid="approve-button"
            onClick={() => void submit("approved", { cache: false })}
            disabled={!approval || submitting}
            className="sm:order-2"
          >
            <Check className="h-4 w-4" />
            Approve (A)
          </Button>
          <Button
            type="button"
            variant="secondary"
            data-testid="approve-remember-button"
            onClick={() => void submit("approved", { cache: true })}
            disabled={!approval || submitting}
            className="sm:order-3"
          >
            <Bookmark className="h-4 w-4" />
            Approve &amp; remember (S)
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
