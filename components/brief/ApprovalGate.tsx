"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { DecisionInput, type DecisionT } from "@/lib/briefs";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

/**
 * Operator-facing approval gate. Three terminal decisions:
 *  - `approved`: notes optional.
 *  - `approved_with_changes`: notes required (must explain the changes).
 *  - `rejected`: notes required (must explain why).
 *
 * Client-side validation mirrors the server-side `DecisionInput` zod
 * refinement so the operator gets immediate feedback. The server is still
 * the source of truth — any client-side bypass returns 400.
 *
 * Reusable primitive: keep this component free of brief-specific copy so
 * it can be reused (e.g. by the future video-brief lifecycle) by passing
 * a different `kind` label + endpoint. Today only `kind="brief"` is wired
 * up; the video version will land in its own PR.
 */
export function ApprovalGate({
  briefId,
  kind = "brief",
  endpoint,
}: {
  briefId: string;
  kind?: string;
  endpoint?: string;
}) {
  const router = useRouter();
  const [decision, setDecision] = useState<DecisionT>("approved");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const requiresNotes = decision !== "approved";
  const resolvedEndpoint = endpoint ?? `/api/briefs/${briefId}/approve`;

  const submit = (next: DecisionT) => {
    setError(null);
    const candidate = { decision: next, notes: notes.trim() ? notes.trim() : undefined };
    const parsed = DecisionInput.safeParse(candidate);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Invalid decision");
      return;
    }

    startTransition(async () => {
      const res = await fetch(resolvedEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed.data),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? `Request failed (${res.status})`);
        return;
      }
      setNotes("");
      router.refresh();
    });
  };

  return (
    <div className="space-y-4 rounded-md border bg-card p-4 shadow-sm">
      <div className="space-y-1">
        <h3 className="text-lg font-semibold">Decide on this {kind}</h3>
        <p className="text-sm text-muted-foreground">
          Notes are required when approving with changes or rejecting.
        </p>
      </div>

      <div className="grid gap-2">
        <Label htmlFor="decision-notes">
          Notes{requiresNotes ? <span className="text-destructive"> *</span> : null}
        </Label>
        <Textarea
          id="decision-notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          onFocus={() => setError(null)}
          rows={3}
          placeholder={
            requiresNotes
              ? "Explain what needs to change or why this is rejected."
              : "Optional — anything you want to record."
          }
          aria-invalid={requiresNotes && notes.trim().length === 0}
        />
      </div>

      {error ? (
        <div
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </div>
      ) : null}

      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:gap-3">
        <Button
          type="button"
          disabled={isPending}
          onClick={() => {
            setDecision("approved");
            submit("approved");
          }}
          className="min-h-11"
        >
          {isPending && decision === "approved" ? "Approving…" : "Approve"}
        </Button>
        <Button
          type="button"
          variant="secondary"
          disabled={isPending}
          onClick={() => {
            setDecision("approved_with_changes");
            submit("approved_with_changes");
          }}
          className="min-h-11"
        >
          {isPending && decision === "approved_with_changes"
            ? "Submitting…"
            : "Approve with changes"}
        </Button>
        <Button
          type="button"
          variant="destructive"
          disabled={isPending}
          onClick={() => {
            setDecision("rejected");
            submit("rejected");
          }}
          className="min-h-11"
        >
          {isPending && decision === "rejected" ? "Rejecting…" : "Reject"}
        </Button>
      </div>
    </div>
  );
}
