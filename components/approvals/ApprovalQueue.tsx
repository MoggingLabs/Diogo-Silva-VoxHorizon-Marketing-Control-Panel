"use client";

import Link from "next/link";
import type { Route } from "next";
import { useCallback, useState } from "react";
import { Bell } from "lucide-react";

import { useApprovalsSubscription } from "@/hooks/approvals/useApprovalsSubscription";
import type { Approval, ApprovalDecision } from "@/lib/approvals/types";
import { cn } from "@/lib/utils";

import { ApprovalCard } from "./ApprovalCard";
import { ApprovalModal } from "./ApprovalModal";

/**
 * Mounted once at the top of `AppShell`. Owns:
 *   - the badge button in the header (shows the pending count)
 *   - a dropdown listing the pending approvals as cards
 *   - the global ApprovalModal that opens on new approvals or row click
 *
 * Visibility: rendered on every page since it sits in the layout chrome.
 *
 * Realtime: Supabase Realtime drives both the badge count and the modal
 * pop-up. INSERT fires `onNewApproval` which auto-opens the modal so the
 * operator sees the request within ~1s of the worker writing the row.
 */
export type ApprovalQueueProps = {
  /** Override the auto-open-on-insert behaviour (used by tests). */
  autoOpenOnInsert?: boolean;
  className?: string;
};

/**
 * Submit a decision to the server. Wrapped here so the queue's `onDecide`
 * + per-card decisions share one code path.
 */
async function postDecision(
  approvalId: string,
  decision: ApprovalDecision,
  opts: { notes?: string; cache_for_session: boolean },
): Promise<void> {
  const res = await fetch(`/api/approvals/${approvalId}/decision`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      decision,
      notes: opts.notes,
      cache_for_session: opts.cache_for_session,
    }),
  });
  if (!res.ok) {
    throw new Error(`Decision failed: HTTP ${res.status}`);
  }
}

export function ApprovalQueue({ autoOpenOnInsert = true, className }: ApprovalQueueProps) {
  const [open, setOpen] = useState(false); // sidebar dropdown open state
  const [modalOpen, setModalOpen] = useState(false);
  const [active, setActive] = useState<Approval | null>(null);

  const handleNewApproval = useCallback(
    (a: Approval) => {
      // Always select the new one so the queue shows it as active; only
      // auto-open the modal when configured.
      setActive(a);
      if (autoOpenOnInsert) setModalOpen(true);
    },
    [autoOpenOnInsert],
  );

  const handleResolved = useCallback(
    (a: Approval) => {
      // If the resolved approval is the one in the modal, close it. The list
      // refresh handled by the subscription strips it from the dropdown.
      setActive((current) => (current && current.id === a.id ? null : current));
      setModalOpen((current) => (active && active.id === a.id ? false : current));
    },
    [active],
  );

  const { approvals, count, loading, error, refresh } = useApprovalsSubscription({
    onNewApproval: handleNewApproval,
    onApprovalResolved: handleResolved,
  });

  const onDecide = useCallback(
    async (decision: ApprovalDecision, opts: { notes?: string; cache_for_session: boolean }) => {
      if (!active) return;
      try {
        await postDecision(active.id, decision, opts);
        setModalOpen(false);
        await refresh();
      } catch (e) {
        // Log + leave the modal open so the operator can retry. Surfacing
        // an inline toast is out of scope here — the audit page shows the
        // row as still pending if the POST failed.
        console.warn(
          `[ApprovalQueue] decision failed for ${active.id}:`,
          e instanceof Error ? e.message : e,
        );
      }
    },
    [active, refresh],
  );

  const openModalFor = useCallback((a: Approval) => {
    setActive(a);
    setModalOpen(true);
    setOpen(false);
  }, []);

  // After an inline Approve/Reject on a card, revalidate the queue so the
  // resolved row drops out — same as the modal's success path.
  const onCardDecided = useCallback(
    async (a: Approval) => {
      setActive((current) => (current && current.id === a.id ? null : current));
      await refresh();
    },
    [refresh],
  );

  return (
    <div className={cn("relative", className)} data-testid="approval-queue">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Pending approvals (${count})`}
        data-testid="approval-queue-toggle"
        className={cn(
          "relative inline-flex h-9 items-center gap-1 rounded-md px-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        )}
      >
        <Bell className="h-4 w-4" aria-hidden="true" />
        <span className="hidden sm:inline">Approvals</span>
        {count > 0 ? (
          <span
            data-testid="approval-queue-badge"
            className="ml-1 inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded-full bg-destructive px-1 text-[11px] font-semibold text-destructive-foreground"
          >
            {count}
          </span>
        ) : null}
      </button>

      {open ? (
        <div
          data-testid="approval-queue-dropdown"
          className="absolute right-0 top-full z-50 mt-2 w-[360px] max-w-[92vw] rounded-md border border-border bg-popover p-2 shadow-lg"
          role="menu"
        >
          <div className="flex items-center justify-between border-b border-border pb-1.5">
            <h2 className="text-sm font-semibold">Pending approvals</h2>
            <Link
              href={"/approvals" as Route}
              className="text-xs text-muted-foreground hover:text-foreground"
              onClick={() => setOpen(false)}
            >
              View all
            </Link>
          </div>
          <div className="mt-2 flex max-h-[60vh] flex-col gap-1 overflow-y-auto">
            {loading ? (
              <p className="px-1 py-2 text-sm text-muted-foreground">Loading…</p>
            ) : error ? (
              <p className="px-1 py-2 text-sm text-destructive" data-testid="queue-error">
                {error}
              </p>
            ) : approvals.length === 0 ? (
              <p
                className="px-1 py-4 text-center text-sm italic text-muted-foreground"
                data-testid="queue-empty"
              >
                No pending approvals.
              </p>
            ) : (
              approvals.map((approval) => (
                <ApprovalCard
                  key={approval.id}
                  approval={approval}
                  active={active?.id === approval.id}
                  onSelect={openModalFor}
                  onDecided={onCardDecided}
                />
              ))
            )}
          </div>
        </div>
      ) : null}

      <ApprovalModal
        approval={active}
        open={modalOpen}
        onOpenChange={setModalOpen}
        onDecide={onDecide}
      />
    </div>
  );
}
