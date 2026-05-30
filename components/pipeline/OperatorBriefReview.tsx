"use client";

import { useCallback, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, ChevronDown, ChevronRight } from "lucide-react";

import { StageShell } from "./StageShell";
import type { Brief } from "@/lib/briefs";
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
 * The canonical brief the operator wrote lives in the `briefs` row linked by
 * `image_brief_id` (passed down as `imageBrief`), in a concepts-first shape.
 * That row is the source of truth and is rendered when present. The legacy
 * `config_draft.image_payload` offer/market/audience shape is the fallback for
 * MANUAL pipelines that never wrote a briefs row. `config_draft.notes` is the
 * operator's reasoning; `config_draft.operator_instruction` is the manager's
 * original ask. Both still read from `config_draft`.
 */
export type OperatorBriefReviewProps = {
  pipeline: Pipeline;
  /** The canonical `briefs` row the operator authored, or null for manual pipelines. */
  imageBrief?: Brief | null;
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

// The concepts-first shape the operator actually writes into `briefs.payload`.
// It is operator-authored jsonb, so every field is read defensively.
type OperatorConcept = {
  concept_name?: unknown;
  prompt?: unknown;
  use_case?: unknown;
  qa_notes?: unknown;
  best_paired_offer?: unknown;
  concept_key?: unknown;
};

type OperatorBriefPayload = {
  market?: unknown;
  service?: unknown;
  audience?: unknown;
  client_name?: unknown;
  manager_review_request?: unknown;
  global_negative_constraints?: unknown;
  format_instructions?: unknown;
  concepts?: unknown;
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

export function OperatorBriefReview({ pipeline, imageBrief }: OperatorBriefReviewProps) {
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

  // The canonical operator brief, read from the linked `briefs` row when one
  // exists. When it does, we render the concepts-first view from it; otherwise
  // we fall back to the legacy `config_draft.image_payload` shape.
  const operatorPayload = useMemo<OperatorBriefPayload | null>(() => {
    const raw = imageBrief?.payload;
    return raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as OperatorBriefPayload)
      : null;
  }, [imageBrief]);

  const concepts = useMemo<OperatorConcept[]>(() => {
    const raw = operatorPayload?.concepts;
    if (!Array.isArray(raw)) return [];
    return raw.filter((c): c is OperatorConcept => !!c && typeof c === "object");
  }, [operatorPayload]);

  const opMarket = asString(operatorPayload?.market);
  const opService = asString(operatorPayload?.service);
  const opAudience = asString(operatorPayload?.audience);
  const opClientName = asString(operatorPayload?.client_name);
  const opReviewRequest = asString(operatorPayload?.manager_review_request);
  const opNegatives = asStringArray(operatorPayload?.global_negative_constraints);
  const opFormatInstructions = useMemo<[string, string][]>(() => {
    const raw = operatorPayload?.format_instructions;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    return Object.entries(raw as Record<string, unknown>)
      .map(([k, v]): [string, string] | null => {
        const val = asString(v);
        return val ? [k, val] : null;
      })
      .filter((e): e is [string, string] => e !== null);
  }, [operatorPayload]);

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

          {operatorPayload ? (
            <>
              {/* Canonical operator brief (briefs row): concepts-first shape. */}
              <section className="grid gap-4 sm:grid-cols-2">
                <BriefField label="Market" value={opMarket} />
                <BriefField label="Audience" value={opAudience} />
                <BriefField label="Service" value={opService} />
                {opClientName ? <BriefField label="Client" value={opClientName} /> : null}
              </section>

              {/* The concepts the operator authored: the core of the brief. */}
              <section className="flex flex-col gap-3">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Concepts
                </h3>
                {concepts.length > 0 ? (
                  <ul className="flex flex-col gap-4">
                    {concepts.map((concept, idx) => (
                      <ConceptCard
                        key={asString(concept.concept_key) ?? `concept-${idx}`}
                        concept={concept}
                      />
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-muted-foreground">No concepts authored yet.</p>
                )}
              </section>

              {/* Global negative constraints: visually distinct compliance. */}
              {opNegatives.length > 0 ? (
                <section
                  aria-label="Global negative constraints"
                  className="flex flex-col gap-2 rounded-md border border-warning/40 bg-warning/10 px-4 py-3"
                >
                  <div className="flex items-center gap-2">
                    <AlertTriangle aria-hidden="true" className="h-4 w-4 text-warning" />
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-warning">
                      Global negative constraints
                    </h3>
                  </div>
                  <ul className="flex flex-col gap-1">
                    {opNegatives.map((rule) => (
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

              {/* Format instructions (per-ratio guidance). */}
              {opFormatInstructions.length > 0 ? (
                <section className="flex flex-col gap-2">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Format instructions
                  </h3>
                  <dl className="flex flex-col gap-2">
                    {opFormatInstructions.map(([key, value]) => (
                      <div key={key} className="flex flex-col gap-0.5">
                        <dt className="text-xs font-medium text-foreground">{key}</dt>
                        <dd className="text-sm text-muted-foreground">{value}</dd>
                      </div>
                    ))}
                  </dl>
                </section>
              ) : null}

              {/* The operator's note to the manager for this review. */}
              {opReviewRequest ? (
                <section className="flex flex-col gap-1">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    For your review
                  </h3>
                  <p className="whitespace-pre-wrap rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-foreground">
                    {opReviewRequest}
                  </p>
                </section>
              ) : null}
            </>
          ) : (
            <>
              {/* Offer: the most important line of the brief. */}
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

              {/* Do-not-say / must-avoid compliance rules (visually distinct). */}
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
              {proofPoints.length > 0 ? (
                <BriefList label="Proof points" items={proofPoints} />
              ) : null}
              {secondaryOffers.length > 0 ? (
                <BriefList label="Secondary offers" items={secondaryOffers} />
              ) : null}

              {/* Free-text strategy fields. */}
              <section className="grid gap-4 sm:grid-cols-2">
                <BriefField label="Brand tone" value={brandTone} />
                <BriefField label="Creative direction" value={creativeDirection} />
                <BriefField label="Location notes" value={locationNotes} />
              </section>
            </>
          )}

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

function ConceptCard({ concept }: { concept: OperatorConcept }) {
  const name = asString(concept.concept_name);
  const prompt = asString(concept.prompt);
  const useCase = asString(concept.use_case);
  const pairedOffer = asString(concept.best_paired_offer);
  const qaNotes = asString(concept.qa_notes);

  return (
    <li className="flex flex-col gap-2 rounded-md border border-border bg-card px-4 py-3">
      <h4 className="text-sm font-semibold text-foreground">{name ?? "Untitled concept"}</h4>
      {pairedOffer ? <p className="text-sm font-medium text-foreground">{pairedOffer}</p> : null}
      {prompt ? (
        <div className="flex flex-col gap-0.5">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Prompt
          </span>
          <p className="whitespace-pre-wrap text-sm text-muted-foreground">{prompt}</p>
        </div>
      ) : null}
      {useCase ? (
        <div className="flex flex-col gap-0.5">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Use case
          </span>
          <p className="text-sm text-muted-foreground">{useCase}</p>
        </div>
      ) : null}
      {qaNotes ? (
        <div className="flex flex-col gap-0.5">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            QA notes
          </span>
          <p className="text-sm text-muted-foreground">{qaNotes}</p>
        </div>
      ) : null}
    </li>
  );
}

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
