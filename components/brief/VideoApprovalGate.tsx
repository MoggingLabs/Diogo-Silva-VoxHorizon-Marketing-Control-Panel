"use client";

import { useRouter } from "next/navigation";
import * as React from "react";

import { Decision, type DecisionT } from "@/lib/video-briefs";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

const DECISION_LABELS: Record<DecisionT, string> = {
  approved: "Approve",
  approved_with_changes: "Approve with changes",
  rejected: "Reject",
};

const DECISION_VARIANTS: Record<DecisionT, "default" | "secondary" | "destructive"> = {
  approved: "default",
  approved_with_changes: "secondary",
  rejected: "destructive",
};

export interface VideoApprovalGateProps {
  videoBriefId: string;
}

/**
 * Approval gate for a posted video brief.
 *
 * Renders three decision buttons (`approved`, `approved_with_changes`,
 * `rejected`) with a notes textarea. `approved_with_changes` and `rejected`
 * require notes — both client- and server-side. Server-side validation lives
 * in `lib/video-briefs.ts` (`DecisionInput`); this component mirrors it for
 * fast feedback.
 *
 * Image-side `<ApprovalGate />` is owned by Agent X and lives in
 * `components/brief/ApprovalGate.tsx`. The two will be consolidated into a
 * single shared primitive in a follow-up PR once both verticals exist.
 */
export function VideoApprovalGate({ videoBriefId }: VideoApprovalGateProps) {
  const router = useRouter();
  const [notes, setNotes] = React.useState("");
  const [decision, setDecision] = React.useState<DecisionT | null>(null);
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const handleSubmit = React.useCallback(
    async (chosen: DecisionT) => {
      setError(null);

      // Mirror server-side rule so we don't make a doomed request.
      const requiresNotes = chosen !== "approved";
      if (requiresNotes && notes.trim().length === 0) {
        setDecision(chosen);
        setError("Notes are required for this decision.");
        return;
      }

      // Defensive zod parse — catches typos before the network round trip.
      const parsed = Decision.safeParse(chosen);
      if (!parsed.success) {
        setError("Invalid decision.");
        return;
      }

      setSubmitting(true);
      setDecision(chosen);
      try {
        const res = await fetch(`/api/briefs/video/${videoBriefId}/approve`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            decision: chosen,
            notes: notes.trim() || undefined,
          }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          throw new Error(body.error ?? `Request failed (${res.status})`);
        }
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setSubmitting(false);
      }
    },
    [notes, router, videoBriefId],
  );

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
          className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </div>
      )}

      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        {Decision.options.map((d) => (
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
