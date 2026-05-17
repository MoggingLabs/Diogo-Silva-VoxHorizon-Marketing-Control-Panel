"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import type { Brief } from "@/lib/briefs";
import type { Creative } from "@/lib/creatives";
import { createLaunchPackage } from "@/lib/pipeline/client";

/**
 * Prefilled snapshot the server-side `/launches/new` page hands to the
 * client form when arriving via the pipeline handoff.
 *
 * Pipeline-handoff mode:
 *   - `pipeline_id` is included so the API can complete the bidirectional
 *     link (UPDATE pipelines.launch_package_id) after insertion.
 *   - `brief` is the originating image brief; the form derives `brief_id`
 *     from it for the POST body.
 *   - `creatives` are the v1.x finals the worker produced. They're
 *     attached implicitly via the brief — the API re-fetches approved
 *     creatives for the brief and bundles those, so we don't need to
 *     forward IDs. The list is here for display + the "remove" affordance.
 *   - `budget_hint` mirrors `pipelines.config_draft.budget` so the
 *     operator can see what they configured upstream; the launch payload
 *     pulls the actual figure from the brief.
 */
export type LaunchBuilderPrefill = {
  pipeline_id: string;
  brief: Pick<Brief, "id" | "brief_id_human"> | null;
  creatives: Creative[];
  budget_hint: number | null;
};

export type EligibleBrief = {
  id: string;
  brief_id_human: string;
  client_name: string | null;
};

export type LaunchBuilderFormProps =
  | { mode: "scratch"; eligibleBriefs: EligibleBrief[]; prefill?: never }
  | { mode: "pipeline"; eligibleBriefs?: never; prefill: LaunchBuilderPrefill };

/**
 * Launch builder — client form.
 *
 * Two modes:
 *   - **scratch**: simple dropdown of approved briefs.
 *   - **pipeline**: prefilled with the pipeline's brief + final creatives;
 *     submitting calls `POST /api/launches` with both `brief_id` and
 *     `pipeline_id` so the API completes the bidirectional link.
 *
 * In both modes the API is the single source of truth for the bundled
 * payload (approved creatives, paired copy, validation). The form simply
 * collects the operator's intent and hands it off. After a clean 201 we
 * redirect to the new launch's detail page; on 422 we surface the error
 * inline and let the operator try again.
 *
 * Trim behaviour: in pipeline mode, the operator can deselect creatives
 * before submitting. Today the API doesn't take creative-id overrides
 * (it re-derives from the brief), so deselection is a soft warning — we
 * keep the affordance for the UX continuity but note it's display-only.
 */
export function LaunchBuilderForm(props: LaunchBuilderFormProps) {
  const router = useRouter();
  const [selectedBriefId, setSelectedBriefId] = useState<string>(() =>
    props.mode === "pipeline" ? (props.prefill.brief?.id ?? "") : "",
  );
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const pipelineId = props.mode === "pipeline" ? props.prefill.pipeline_id : null;
  // Snapshot the prefilled creatives once via lazy state init. The form is
  // mounted by a server-rendered page so `props` are effectively static for
  // the form's lifetime — we lock the value in to keep `useMemo` deps stable
  // for the visible-creatives derivation below.
  const [prefillCreatives] = useState<Creative[]>(() =>
    props.mode === "pipeline" ? props.prefill.creatives : [],
  );
  const visibleCreatives = useMemo(
    () => prefillCreatives.filter((c) => !excluded.has(c.id)),
    [prefillCreatives, excluded],
  );
  const budgetHint = props.mode === "pipeline" ? props.prefill.budget_hint : null;

  const canSubmit = selectedBriefId.length > 0 && !isPending;

  const onSubmit = () => {
    setError(null);
    if (!selectedBriefId) {
      setError("Pick a brief before submitting.");
      return;
    }
    startTransition(async () => {
      try {
        const launch = await createLaunchPackage({
          brief_id: selectedBriefId,
          ...(pipelineId ? { pipeline_id: pipelineId } : {}),
        });
        router.push(`/launches/${launch.id}`);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    });
  };

  return (
    <form
      className="flex flex-col gap-6"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      {props.mode === "scratch" ? (
        <div className="space-y-2 rounded-md border bg-card p-4 shadow-sm">
          <Label htmlFor="brief-select">Approved brief</Label>
          <select
            id="brief-select"
            value={selectedBriefId}
            onChange={(e) => setSelectedBriefId(e.target.value)}
            className="block h-10 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <option value="">Select an approved brief…</option>
            {props.eligibleBriefs.map((b) => (
              <option key={b.id} value={b.id}>
                {b.brief_id_human}
                {b.client_name ? ` — ${b.client_name}` : ""}
              </option>
            ))}
          </select>
          {props.eligibleBriefs.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No approved briefs found. Approve a brief first, then return here.
            </p>
          ) : null}
        </div>
      ) : (
        <div className="space-y-3 rounded-md border bg-card p-4 shadow-sm">
          <div className="space-y-1">
            <h2 className="text-base font-semibold">Brief reference</h2>
            <p className="text-xs text-muted-foreground">
              Auto-selected from the pipeline. Editing isn&apos;t supported in handoff mode — start
              a new launch from scratch if you want a different brief.
            </p>
          </div>
          {props.prefill.brief ? (
            <p className="font-mono text-sm">{props.prefill.brief.brief_id_human}</p>
          ) : (
            <p className="text-sm text-amber-700">
              This pipeline has no image brief — only image launches are supported in v1.
            </p>
          )}
          {typeof budgetHint === "number" ? (
            <p className="text-xs text-muted-foreground">
              <span className="font-medium text-foreground">Budget hint:</span> $
              {budgetHint.toLocaleString()} (from pipeline config)
            </p>
          ) : null}
        </div>
      )}

      {props.mode === "pipeline" && prefillCreatives.length > 0 ? (
        <div className="space-y-3 rounded-md border bg-card p-4 shadow-sm">
          <div className="space-y-1">
            <h2 className="text-base font-semibold">
              Attached creatives ({visibleCreatives.length} of {prefillCreatives.length})
            </h2>
            <p className="text-xs text-muted-foreground">
              These are the v1.x finals from the pipeline. The launch payload re-derives the bundle
              from the brief at submit time — toggling here is informational.
            </p>
          </div>
          <ul className="space-y-2">
            {prefillCreatives.map((c) => {
              const isExcluded = excluded.has(c.id);
              return (
                <li
                  key={c.id}
                  className="flex items-baseline justify-between gap-3 rounded border bg-background px-3 py-2 text-sm"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{c.concept ?? "Untitled"}</p>
                    <p className="font-mono text-[11px] text-muted-foreground">
                      {c.ratio ?? "—"} · {c.version} · {c.status}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      setExcluded((prev) => {
                        const next = new Set(prev);
                        if (next.has(c.id)) next.delete(c.id);
                        else next.add(c.id);
                        return next;
                      })
                    }
                    className="text-xs underline-offset-4 hover:underline"
                  >
                    {isExcluded ? "Re-include" : "Remove from preview"}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      {error ? (
        <div
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={!canSubmit} className="min-h-11">
          {isPending ? "Building…" : "Build launch package"}
        </Button>
        <button
          type="button"
          onClick={() => router.back()}
          className="text-sm underline-offset-4 hover:underline"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
