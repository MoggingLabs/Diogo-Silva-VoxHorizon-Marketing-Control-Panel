"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { CreativeDecisionT } from "@/lib/creatives";

export type DecisionButtonsProps = {
  creativeId: string;
};

/**
 * Operator-facing approve/reject pair for a single image creative.
 *
 * Optimistic UX: clicking either button shows an inline `Approving…` /
 * `Rejecting…` label and disables both buttons until the API responds.
 * The Realtime subscription on `creatives` (owned by the parent grid)
 * reconciles the visible status pill once the DB update propagates;
 * here we also call `router.refresh()` so any server-rendered
 * decision metadata (the "Decided · …" block in the side panel)
 * stays in sync.
 *
 * Reject uses a one-step confirmation via the browser's native
 * `confirm()` dialog. It's intentionally lightweight — we don't want to
 * pull in `<AlertDialog />` just for a yes/no in this PR. Approve is
 * non-destructive enough to skip the confirm.
 */
export function DecisionButtons({ creativeId }: DecisionButtonsProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [activeDecision, setActiveDecision] = useState<CreativeDecisionT | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = (decision: CreativeDecisionT) => {
    setError(null);
    setActiveDecision(decision);
    startTransition(async () => {
      try {
        const res = await fetch(`/api/creatives/${creativeId}/decision`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ decision }),
        });
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { error?: string };
          setError(data.error ?? `Request failed (${res.status})`);
          setActiveDecision(null);
          return;
        }
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Network error");
        setActiveDecision(null);
      }
    });
  };

  const onReject = () => {
    if (
      typeof window !== "undefined" &&
      !window.confirm("Reject this creative? You can't change the decision later.")
    ) {
      return;
    }
    submit("reject");
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          disabled={isPending}
          onClick={() => submit("approve")}
          className="bg-emerald-600 text-white hover:bg-emerald-700"
        >
          <Check aria-hidden="true" className="h-4 w-4" />
          {isPending && activeDecision === "approve" ? "Approving…" : "Approve"}
        </Button>
        <Button type="button" variant="destructive" disabled={isPending} onClick={onReject}>
          <X aria-hidden="true" className="h-4 w-4" />
          {isPending && activeDecision === "reject" ? "Rejecting…" : "Reject"}
        </Button>
      </div>
      {error ? (
        <div
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          {error}
        </div>
      ) : null}
    </div>
  );
}
