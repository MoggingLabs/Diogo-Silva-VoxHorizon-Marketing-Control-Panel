"use client";

import { useRouter } from "next/navigation";
import * as React from "react";

import { VideoLaunchDecision, type VideoLaunchDecisionT } from "@/lib/video-launches";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

const DECISION_LABELS: Record<VideoLaunchDecisionT, string> = {
  approved: "Approve",
  approved_with_changes: "Approve with changes",
  rejected: "Reject",
};

const DECISION_VARIANTS: Record<VideoLaunchDecisionT, "default" | "secondary" | "destructive"> = {
  approved: "default",
  approved_with_changes: "secondary",
  rejected: "destructive",
};

export interface VideoLaunchApprovalGateProps {
  launchId: string;
}

/**
 * Approval gate for a posted video launch package. Mirrors
 * ``<VideoApprovalGate />`` from the brief-side, but POSTs to
 * ``/api/launches/video/:id/decision`` and validates with the launch-side
 * zod schema. ``approved_with_changes`` and ``rejected`` require notes.
 */
export function VideoLaunchApprovalGate({ launchId }: VideoLaunchApprovalGateProps) {
  const router = useRouter();
  const [notes, setNotes] = React.useState("");
  const [decision, setDecision] = React.useState<VideoLaunchDecisionT | null>(null);
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const handleSubmit = React.useCallback(
    async (chosen: VideoLaunchDecisionT) => {
      setError(null);

      const requiresNotes = chosen !== "approved";
      if (requiresNotes && notes.trim().length === 0) {
        setDecision(chosen);
        setError("Notes are required for this decision.");
        return;
      }

      const parsed = VideoLaunchDecision.safeParse(chosen);
      if (!parsed.success) {
        setError("Invalid decision.");
        return;
      }

      setSubmitting(true);
      setDecision(chosen);
      try {
        const res = await fetch(`/api/launches/video/${launchId}/decision`, {
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
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setSubmitting(false);
      }
    },
    [notes, router, launchId],
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

      <div className="flex flex-wrap gap-2">
        {VideoLaunchDecision.options.map((d) => (
          <Button
            key={d}
            type="button"
            variant={DECISION_VARIANTS[d]}
            disabled={submitting}
            onClick={() => handleSubmit(d)}
          >
            {submitting && decision === d ? "Submitting…" : DECISION_LABELS[d]}
          </Button>
        ))}
      </div>
    </div>
  );
}
