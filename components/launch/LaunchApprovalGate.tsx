"use client";

import { useRouter } from "next/navigation";
import * as React from "react";

import { LaunchDecision, type LaunchDecisionT } from "@/lib/launches";
import { useLaunchStatus, type LaunchStatusValue } from "@/components/launch/LaunchStatusBadge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

const DECISION_LABELS: Record<LaunchDecisionT, string> = {
  approved: "Approve",
  approved_with_changes: "Approve with changes",
  rejected: "Reject",
};

const DECISION_VARIANTS: Record<LaunchDecisionT, "default" | "secondary" | "destructive"> = {
  approved: "default",
  approved_with_changes: "secondary",
  rejected: "destructive",
};

export interface LaunchApprovalGateProps {
  launchId: string;
}

/**
 * Approval gate for a posted image launch package. Mirrors
 * ``<VideoLaunchApprovalGate />`` but POSTs to ``/api/launches/:id/decision``
 * and validates with the image-side launch zod schema. ``approved_with_changes``
 * and ``rejected`` require notes.
 *
 * The image detail page previously reused the shared brief ``<ApprovalGate />``;
 * it now has its own gate so it can drive the optimistic status flip (the
 * shared brief gate is kept brief-specific). On a successful decision POST the
 * gate pushes the new status into the shared status context so the header pill
 * flips immediately, then calls ``router.refresh()`` in the background. Same
 * philosophy as #636.
 */
export function LaunchApprovalGate({ launchId }: LaunchApprovalGateProps) {
  const router = useRouter();
  const launchStatus = useLaunchStatus();
  const [notes, setNotes] = React.useState("");
  const [decision, setDecision] = React.useState<LaunchDecisionT | null>(null);
  const [submitting, setSubmitting] = React.useState(false);
  const [decided, setDecided] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const handleSubmit = React.useCallback(
    async (chosen: LaunchDecisionT) => {
      setError(null);

      const requiresNotes = chosen !== "approved";
      if (requiresNotes && notes.trim().length === 0) {
        setDecision(chosen);
        setError("Notes are required for this decision.");
        return;
      }

      const parsed = LaunchDecision.safeParse(chosen);
      if (!parsed.success) {
        setError("Invalid decision.");
        return;
      }

      setSubmitting(true);
      setDecision(chosen);
      try {
        const res = await fetch(`/api/launches/${launchId}/decision`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            decision: chosen,
            notes: notes.trim() || undefined,
          }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `Request failed (${res.status})`);
        }
        const body = (await res.json().catch(() => ({}))) as {
          launch?: { status?: string };
        };
        // Optimistic flip: the decision route returns the updated launch whose
        // status equals the chosen decision. Push it into the shared status
        // context so the header pill flips immediately and hide this gate,
        // instead of waiting on the slow ``router.refresh()`` re-render of the
        // Supabase-heavy detail page. Same philosophy as #636.
        const nextStatus = (body.launch?.status ?? chosen) as LaunchStatusValue;
        launchStatus?.setOptimisticStatus(nextStatus);
        setDecided(true);
        router.refresh();
      } catch (err) {
        // The POST failed: revert any optimistic state so the pill never lies.
        setDecided(false);
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setSubmitting(false);
      }
    },
    [notes, router, launchId, launchStatus],
  );

  // Once a decision lands the gate is done; the controls fold away
  // synchronously so the page does not depend on the slow re-render to drop
  // them (the server re-render then unmounts the gate outright).
  if (decided) return null;

  return (
    <div className="flex flex-col gap-4 rounded-md border border-input bg-background p-4">
      <header className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold">Decision</h2>
        <p className="text-sm text-muted-foreground">
          Approve, approve with changes, or reject. Notes are required for anything other than a
          clean approval.
        </p>
      </header>

      <div className="flex flex-col gap-2">
        <Label htmlFor="decision-notes">Notes</Label>
        <Textarea
          id="decision-notes"
          rows={3}
          placeholder="Required for approve-with-changes and reject"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
      </div>

      {error && (
        <div
          role="alert"
          data-testid="launch-decision-error"
          className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </div>
      )}

      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        {LaunchDecision.options.map((d) => (
          <Button
            key={d}
            type="button"
            variant={DECISION_VARIANTS[d]}
            disabled={submitting}
            onClick={() => handleSubmit(d)}
            className="min-h-11"
          >
            {submitting && decision === d ? "Submitting…" : DECISION_LABELS[d]}
          </Button>
        ))}
      </div>
    </div>
  );
}
