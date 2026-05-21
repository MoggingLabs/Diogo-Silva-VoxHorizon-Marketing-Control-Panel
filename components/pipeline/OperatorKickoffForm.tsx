"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { Bot, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { kickoffOperatorPipeline } from "@/lib/pipeline/client";

/**
 * Operator-driven kickoff affordance for the supervision cockpit.
 *
 * The manager types a free-text brief ("4 roofing ads, Austin, $99
 * inspection") and hits "Hire the operator". That calls
 * `POST /api/pipelines/operator`, which creates the pipeline and dispatches
 * the Hermes operator to start authoring the brief, then we redirect to the
 * new pipeline's detail page where the manager supervises the run.
 *
 * Kept intentionally minimal: one textarea + one button. The configuration
 * stage UI (and the operator itself) own the structured brief from here on.
 */
const EXAMPLE = "4 roofing ads, Austin, $99 inspection offer, owner-led trust angle";

export function OperatorKickoffForm() {
  const router = useRouter();
  const [instruction, setInstruction] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = instruction.trim();
  const canSubmit = trimmed.length > 0 && !submitting;

  const onSubmit = useCallback(async () => {
    if (!trimmed || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const pipeline = await kickoffOperatorPipeline({ instruction: trimmed });
      router.push(`/pipeline/${pipeline.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to start the operator.");
      setSubmitting(false);
    }
    // On success we navigate away, so we deliberately leave `submitting` true
    // to keep the button disabled through the transition.
  }, [router, submitting, trimmed]);

  return (
    <section
      aria-label="Operator kickoff"
      data-testid="operator-kickoff"
      className="flex flex-col gap-4 rounded-lg border border-border bg-card px-5 py-5 shadow-sm sm:px-6"
    >
      <div className="flex items-center gap-2">
        <Bot aria-hidden="true" className="h-5 w-5 text-sky-600 dark:text-sky-400" />
        <h2 className="text-lg font-semibold tracking-tight">Hire the operator</h2>
      </div>
      <p className="text-sm text-muted-foreground">
        Describe the run in plain language. The operator drafts the brief and concepts; you sign off
        at each gate and approve the spend.
      </p>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="operator-instruction">Brief</Label>
        <Textarea
          id="operator-instruction"
          data-testid="operator-instruction"
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          placeholder={EXAMPLE}
          rows={3}
          disabled={submitting}
          onKeyDown={(e) => {
            // Cmd/Ctrl+Enter submits — handy for a power user.
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              void onSubmit();
            }
          }}
        />
      </div>

      {error ? (
        <p
          role="alert"
          data-testid="operator-kickoff-error"
          className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </p>
      ) : null}

      <div className="flex justify-end">
        <Button
          type="button"
          disabled={!canSubmit}
          onClick={() => void onSubmit()}
          className="gap-2"
        >
          {submitting ? (
            <>
              <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />
              Starting…
            </>
          ) : (
            <>
              <Bot aria-hidden="true" className="h-4 w-4" />
              Hire the operator
            </>
          )}
        </Button>
      </div>
    </section>
  );
}
