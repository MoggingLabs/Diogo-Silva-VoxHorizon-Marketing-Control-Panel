"use client";

import { useCallback, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, ChevronDown, ChevronRight } from "lucide-react";

import { StageShell } from "./StageShell";
import type { Pipeline } from "@/lib/pipeline/types";
import { cn } from "@/lib/utils";

/**
 * Operator brief review (configuration gate, operator-driven pipelines).
 *
 * For OPERATOR-DRIVEN pipelines the configuration stage is NOT a manual brief
 * form — the Hermes operator authored a complete brief and stopped for the
 * manager's review. The manager's job here is to READ the authored brief and
 * APPROVE it (operator authors, manager supervises + gates). Approving runs the
 * same `configuration → ideation` advance the manual form uses; the advance
 * route branches on `operator_driven` to re-dispatch the operator to author the
 * concept previews.
 *
 * Everything rendered here is read from `pipeline.config_draft` (already passed
 * down by the page) — no extra fetch. The brief lives at
 * `config_draft.image_payload`; `config_draft.notes` is the operator's
 * reasoning; `config_draft.operator_instruction` is the manager's original ask.
 */
export type OperatorBriefReviewProps = {
  pipeline: Pipeline;
};

// The operator authors a richer brief than the strict manual `BriefPayload`:
// it carries the marketing strategy fields the operator skill produces plus an
// `extras` block of compliance + proof material. We read it loosely (it's
// operator-authored jsonb) and narrow each field defensively.
type ImageBriefExtras = {
  brand_tone?: unknown;
  must_avoid?: unknown;
  proof_points?: unknown;
  secondary_offers?: unknown;
  creative_direction?: unknown;
  location_notes?: unknown;
  asset_notes?: unknown;
  concept_count?: unknown;
  client_name?: unknown;
};

type ImageBrief = {
  service?: unknown;
  offer_text?: unknown;
  market?: unknown;
  audience?: unknown;
  angles?: unknown;
  extras?: ImageBriefExtras;
};

function asString(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
    .map((x) => x.trim());
}

export function OperatorBriefReview({ pipeline }: OperatorBriefReviewProps) {
  const router = useRouter();
  const [advancing, setAdvancing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notesOpen, setNotesOpen] = useState(false);

  const draft = useMemo(
    () => (pipeline.config_draft ?? {}) as Record<string, unknown>,
    [pipeline.config_draft],
  );

  const instruction = useMemo(() => asString(draft.operator_instruction), [draft]);
  const operatorNotes = useMemo(() => asString(draft.notes), [draft]);

  const brief = useMemo(() => {
    const raw = draft.image_payload;
    return raw && typeof raw === "object" ? (raw as ImageBrief) : ({} as ImageBrief);
  }, [draft]);

  const extras: ImageBriefExtras = useMemo(
    () => (brief.extras && typeof brief.extras === "object" ? brief.extras : {}),
    [brief],
  );

  const offerText = asString(brief.offer_text);
  const market = asString(brief.market);
  const audience = asString(brief.audience);
  const service = asString(brief.service);
  const angles = asStringArray(brief.angles);

  const brandTone = asString(extras.brand_tone);
  const mustAvoid = asStringArray(extras.must_avoid);
  const proofPoints = asStringArray(extras.proof_points);
  const secondaryOffers = asStringArray(extras.secondary_offers);
  const creativeDirection = asString(extras.creative_direction);
  const locationNotes = asString(extras.location_notes);
  const clientName = asString(extras.client_name);

  const onApprove = useCallback(async () => {
    if (advancing) return;
    setAdvancing(true);
    setError(null);
    try {
      const res = await fetch(`/api/pipelines/${encodeURIComponent(pipeline.id)}/advance`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
        cache: "no-store",
      });
      if (!res.ok) {
        let detail = "";
        try {
          const body = (await res.json()) as { error?: string };
          detail = body.error ?? "";
        } catch {
          /* ignore */
        }
        throw new Error(detail || `approve failed (${res.status})`);
      }
      // The advance flips the row to `ideation` and re-dispatches the operator;
      // PipelineDetailRealtime will pick up the row change, but we refresh
      // proactively in case realtime is slow.
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setAdvancing(false);
    }
  }, [advancing, pipeline.id, router]);

  // TODO(operator-redispatch): a "Send back with changes" action would
  // re-dispatch the operator with the manager's feedback to re-author the
  // brief. There is no client-callable endpoint for that today —
  // `lib/operator/dispatch.ts` is server-only and `POST /api/pipelines/operator`
  // only *creates* new pipelines. Wire a `POST /api/pipelines/[id]/redispatch`
  // (calling `dispatchOperator` with the feedback) before adding it here rather
  // than inventing backend from the client.

  return (
    <StageShell
      title="Review the operator's brief"
      subtitle="The operator authored this brief and is waiting for your sign-off. Approve to author the concepts."
      canContinue={!advancing}
      onContinue={() => void onApprove()}
      continueLabel={advancing ? "Approving…" : "Approve brief — continue to concepts"}
      body={
        <div className="flex flex-col gap-6">
          {/* The manager's original ask. */}
          {instruction ? (
            <section className="flex flex-col gap-1">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Your instruction
              </h3>
              <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-foreground">
                {instruction}
              </p>
            </section>
          ) : null}

          {/* Offer — the most important line of the brief. */}
          <section className="flex flex-col gap-1">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Offer
            </h3>
            {offerText ? (
              <p className="rounded-md border border-border bg-card px-4 py-3 text-base font-semibold leading-snug text-foreground">
                {offerText}
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">No offer authored yet.</p>
            )}
          </section>

          {/* Market / audience / service summary. */}
          <section className="grid gap-4 sm:grid-cols-2">
            <BriefField label="Market" value={market} />
            <BriefField label="Audience" value={audience} />
            <BriefField label="Service" value={service} />
            {clientName ? <BriefField label="Client" value={clientName} /> : null}
          </section>

          {/* Angles as badges. */}
          {angles.length > 0 ? (
            <section className="flex flex-col gap-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Angles
              </h3>
              <ul className="flex flex-wrap gap-2">
                {angles.map((angle) => (
                  <li
                    key={angle}
                    className="inline-flex items-center rounded-full bg-info/15 px-2.5 py-0.5 text-xs font-medium text-info ring-1 ring-inset ring-info/30"
                  >
                    {angle}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {/* Do-not-say / must-avoid compliance rules — visually distinct. */}
          {mustAvoid.length > 0 ? (
            <section
              aria-label="Do-not-say rules"
              className="flex flex-col gap-2 rounded-md border border-warning/40 bg-warning/10 px-4 py-3"
            >
              <div className="flex items-center gap-2">
                <AlertTriangle aria-hidden="true" className="h-4 w-4 text-warning" />
                <h3 className="text-xs font-semibold uppercase tracking-wide text-warning">
                  Do not say (compliance)
                </h3>
              </div>
              <ul className="flex flex-col gap-1">
                {mustAvoid.map((rule) => (
                  <li key={rule} className="flex items-start gap-2 text-sm text-warning">
                    <span aria-hidden="true" className="mt-1 text-warning">
                      •
                    </span>
                    <span>{rule}</span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {/* Proof points + secondary offers. */}
          {proofPoints.length > 0 ? <BriefList label="Proof points" items={proofPoints} /> : null}
          {secondaryOffers.length > 0 ? (
            <BriefList label="Secondary offers" items={secondaryOffers} />
          ) : null}

          {/* Free-text strategy fields. */}
          <section className="grid gap-4 sm:grid-cols-2">
            <BriefField label="Brand tone" value={brandTone} />
            <BriefField label="Creative direction" value={creativeDirection} />
            <BriefField label="Location notes" value={locationNotes} />
          </section>

          {/* Operator's reasoning — secondary, collapsible. */}
          {operatorNotes ? (
            <section className="flex flex-col gap-2">
              <button
                type="button"
                onClick={() => setNotesOpen((o) => !o)}
                aria-expanded={notesOpen}
                className="inline-flex items-center gap-1.5 self-start text-xs font-semibold uppercase tracking-wide text-muted-foreground hover:text-foreground"
              >
                {notesOpen ? (
                  <ChevronDown aria-hidden="true" className="h-3.5 w-3.5" />
                ) : (
                  <ChevronRight aria-hidden="true" className="h-3.5 w-3.5" />
                )}
                Operator&apos;s reasoning
              </button>
              {notesOpen ? (
                <p className="whitespace-pre-wrap rounded-md border border-dashed border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
                  {operatorNotes}
                </p>
              ) : null}
            </section>
          ) : null}

          {error ? (
            <div
              role="alert"
              className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              {error}
            </div>
          ) : null}
        </div>
      }
    />
  );
}

// ---------------------------------------------------------------------------
// Subcomponents
// ---------------------------------------------------------------------------

function BriefField({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="flex flex-col gap-1">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </h3>
      {value ? (
        <p className="text-sm text-foreground">{value}</p>
      ) : (
        <p className="text-sm text-muted-foreground">—</p>
      )}
    </div>
  );
}

function BriefList({ label, items }: { label: string; items: string[] }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </h3>
      <ul className={cn("flex flex-col gap-1")}>
        {items.map((item) => (
          <li key={item} className="flex items-start gap-2 text-sm text-foreground">
            <span aria-hidden="true" className="mt-1 text-muted-foreground">
              •
            </span>
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
