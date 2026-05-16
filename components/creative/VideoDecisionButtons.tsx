"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  STATUS_LABEL,
  allowedDecisions,
  type VideoCreativeDecisionT,
  type VideoCreativeStatusT,
} from "@/lib/video-creatives";

export type VideoDecisionButtonsProps = {
  creativeId: string;
  status: VideoCreativeStatusT;
};

/**
 * Operator-facing approve/reject pair for a single video creative.
 *
 * Visibility rules (driven by `allowedDecisions` in
 * `lib/video-creatives.ts`):
 *  - `captioned` shows BOTH buttons — approve is the happy-path terminal.
 *  - Earlier statuses (`draft` → `composed`) show only Reject, with an
 *    informational note: "Pipeline still running, approve unlocks at
 *    Captioned."
 *  - Terminal statuses (`approved`, `rejected`) show neither — the side
 *    panel's "Decision" section renders the decision summary instead.
 *
 * Optimistic UX: clicking either button shows an inline label
 * (`Approving…` / `Rejecting…`) and disables both buttons until the API
 * responds. Realtime on the parent grid reconciles the visible status
 * pill when the DB update propagates; here we also call `router.refresh()`
 * so server-rendered metadata stays in sync.
 *
 * Reject confirms via the browser's native `confirm()` dialog —
 * intentionally lightweight; no `<AlertDialog />` needed.
 */
export function VideoDecisionButtons({ creativeId, status }: VideoDecisionButtonsProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [activeDecision, setActiveDecision] = useState<VideoCreativeDecisionT | null>(null);
  const [error, setError] = useState<string | null>(null);

  const allowed = allowedDecisions[status] ?? [];
  const canApprove = allowed.includes("approve");
  const canReject = allowed.includes("reject");

  const submit = (decision: VideoCreativeDecisionT) => {
    setError(null);
    setActiveDecision(decision);
    startTransition(async () => {
      try {
        const res = await fetch(`/api/creatives/video/${creativeId}/decision`, {
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
      !window.confirm("Reject this video creative? You can't change the decision later.")
    ) {
      return;
    }
    submit("reject");
  };

  // Terminal — nothing actionable here.
  if (!canApprove && !canReject) {
    return (
      <div className="rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
        No further decision available. Current status:{" "}
        <span className="font-medium text-foreground">{STATUS_LABEL[status]}</span>.
      </div>
    );
  }

  // Pipeline in progress: only Reject is available; approve gates on captioned.
  const pipelineInProgress = !canApprove;

  return (
    <div className="space-y-2">
      {pipelineInProgress ? (
        <p className="rounded-md border border-dashed bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          Pipeline in progress — wait for{" "}
          <span className="font-medium text-foreground">Captioned</span> status before approving.
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {canApprove ? (
          <Button
            type="button"
            disabled={isPending}
            onClick={() => submit("approve")}
            className="bg-emerald-600 text-white hover:bg-emerald-700"
          >
            <Check aria-hidden="true" className="h-4 w-4" />
            {isPending && activeDecision === "approve" ? "Approving…" : "Approve"}
          </Button>
        ) : null}
        {canReject ? (
          <Button type="button" variant="destructive" disabled={isPending} onClick={onReject}>
            <X aria-hidden="true" className="h-4 w-4" />
            {isPending && activeDecision === "reject" ? "Rejecting…" : "Reject"}
          </Button>
        ) : null}
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
