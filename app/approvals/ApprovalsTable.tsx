"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import type { Approval } from "@/lib/approvals/types";

import { ApprovalAuditTrail } from "@/components/approvals/ApprovalAuditTrail";
import { ApprovalModal } from "@/components/approvals/ApprovalModal";

/**
 * Client island for the `/approvals` page audit log. Renders the
 * `ApprovalAuditTrail` for the supplied row list and lets the operator
 * open one of them in the same modal used by the queue.
 */
export type ApprovalsTableProps = {
  approvals: Approval[];
};

export function ApprovalsTable({ approvals }: ApprovalsTableProps) {
  const router = useRouter();
  const [active, setActive] = useState<Approval | null>(null);
  const [open, setOpen] = useState(false);

  if (approvals.length === 0) {
    return <ApprovalAuditTrail approvals={[]} emptyMessage="No approvals match these filters." />;
  }

  return (
    <>
      <ul data-testid="approvals-table" className="flex flex-col gap-2" aria-label="Approval rows">
        {approvals.map((approval) => (
          <li key={approval.id}>
            <button
              type="button"
              onClick={() => {
                setActive(approval);
                setOpen(true);
              }}
              data-testid={`approvals-table-row-${approval.id}`}
              className="block w-full text-left"
            >
              <span className="sr-only">Open approval {approval.id}</span>
              <ApprovalAuditTrail approvals={[approval]} />
            </button>
          </li>
        ))}
      </ul>
      <ApprovalModal
        approval={active}
        open={open}
        onOpenChange={setOpen}
        onDecide={async (decision, opts) => {
          if (!active) return;
          try {
            const res = await fetch(`/api/approvals/${active.id}/decision`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                decision,
                notes: opts.notes,
                cache_for_session: opts.cache_for_session,
              }),
            });
            if (res.ok) {
              setOpen(false);
              router.refresh();
            }
          } catch (e) {
            console.warn(
              `[ApprovalsTable] decision failed for ${active.id}:`,
              e instanceof Error ? e.message : e,
            );
          }
        }}
      />
    </>
  );
}
