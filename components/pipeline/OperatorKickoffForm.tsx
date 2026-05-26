"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Bot, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  DEFAULT_FINALS_MODEL_LABEL,
  FINALS_MODEL_OPTIONS,
  kickoffOperatorPipeline,
} from "@/lib/pipeline/client";
import { fetchClients, type ClientOption } from "@/lib/realtime/client-data";

/**
 * Sentinel value for the "no client" option. Radix `Select` items can't use an
 * empty-string value, so we use a non-uuid token and map it back to "no
 * client" (omitted from the POST body) when the manager keeps the default.
 */
const NO_CLIENT = "__none__";

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

  // Optional client picker. The operator picks up the chosen client's brand
  // voice / offers / do-not-say constraints; leaving it on "No client" runs a
  // generic pipeline. Fetched on mount via the service-role `/api/clients`
  // route (the anon browser key can't read `clients` after the RLS lockdown).
  const [clientId, setClientId] = useState<string>(NO_CLIENT);
  const [clients, setClients] = useState<ClientOption[]>([]);
  const [clientsLoading, setClientsLoading] = useState(true);

  // The image model used for the FINALS (generation) renders, chosen per
  // pipeline at kickoff. Defaults to the FREE codex model. Ideation always
  // renders free regardless of this — it is never selectable to a paid model.
  const [finalsModel, setFinalsModel] = useState<string>(DEFAULT_FINALS_MODEL_LABEL);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await fetchClients();
        if (!cancelled) setClients(data);
      } catch {
        // Soft-fail: the client picker is optional, so a load failure just
        // leaves it empty/disabled — the manager can still kick off generically.
      } finally {
        if (!cancelled) setClientsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const trimmed = instruction.trim();
  const canSubmit = trimmed.length > 0 && !submitting;

  const onSubmit = useCallback(async () => {
    if (!trimmed || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const pipeline = await kickoffOperatorPipeline({
        instruction: trimmed,
        finals_model: finalsModel,
        ...(clientId !== NO_CLIENT ? { client_id: clientId } : {}),
      });
      router.push(`/pipeline/${pipeline.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to start the operator.");
      setSubmitting(false);
    }
    // On success we navigate away, so we deliberately leave `submitting` true
    // to keep the button disabled through the transition.
  }, [clientId, finalsModel, router, submitting, trimmed]);

  return (
    <section
      aria-label="Operator kickoff"
      data-testid="operator-kickoff"
      className="flex flex-col gap-4 rounded-lg border border-border bg-card px-5 py-5 shadow-sm sm:px-6"
    >
      <div className="flex items-center gap-2">
        <Bot aria-hidden="true" className="h-5 w-5 text-info" />
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

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="operator-client">Client (optional)</Label>
        <Select value={clientId} onValueChange={setClientId} disabled={submitting}>
          <SelectTrigger
            id="operator-client"
            data-testid="operator-client"
            aria-label="Client (optional)"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NO_CLIENT}>No client / generic</SelectItem>
            {clients.map((c) => (
              <SelectItem key={c.id} value={c.id}>
                {c.name} <span className="text-muted-foreground">({c.slug})</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          {clientsLoading
            ? "Loading clients…"
            : "Pick a client to give the operator its brand voice, offers, and do-not-say rules."}
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="operator-finals-model">Finals model</Label>
        <Select value={finalsModel} onValueChange={setFinalsModel} disabled={submitting}>
          <SelectTrigger
            id="operator-finals-model"
            data-testid="operator-finals-model"
            aria-label="Finals model"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {FINALS_MODEL_OPTIONS.map((opt) => (
              <SelectItem key={opt.label} value={opt.label}>
                {opt.label} <span className="text-muted-foreground">({opt.cost})</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          Model for the final production renders. Ideation previews are always free (gpt-image-2).
          Paid models bill per image.
        </p>
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
