"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { CopyComposer, type CopyVariantView } from "@/components/copy/CopyComposer";
import { StageShell } from "@/components/pipeline/StageShell";
import { copyGateCleared, isCreativeInScope, MIN_APPROVED_COPY } from "@/lib/pipeline/rollup";
import { type GridCreative } from "@/lib/review/grid";

/**
 * Copy stage host (#359, P4.4). Renders a `CopyComposer` per in-scope creative
 * so the manager authors / approves ≥3 variants each. Continue unlocks once
 * every in-scope creative has ≥3 approved variants; it POSTs to the advance
 * route.
 */
export type StageCopyProps = {
  pipelineId: string;
  creatives: GridCreative[];
  /** All copy variants for the pipeline, keyed by creative below. */
  variants: CopyVariantView[];
  suggestions?: string[];
};

export function StageCopy({ pipelineId, creatives, variants, suggestions }: StageCopyProps) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const inScope = creatives.filter((c) => isCreativeInScope(c));
  const byCreative = new Map<string, CopyVariantView[]>();
  for (const v of variants) {
    const list = byCreative.get(v.creative_id) ?? [];
    list.push(v);
    byCreative.set(v.creative_id, list);
  }

  // Single-source copy-gate predicate (≥MIN_APPROVED_COPY approved per in-scope
  // creative) — the same one the advance route + launch checklist enforce.
  const approvedByCreative = new Map<string, number>();
  for (const c of inScope) {
    approvedByCreative.set(
      c.id,
      (byCreative.get(c.id) ?? []).filter((v) => v.status === "approved").length,
    );
  }
  const allHaveEnough = copyGateCleared(
    inScope.map((c) => c.id),
    approvedByCreative,
  ).cleared;

  const advance = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/pipelines/${pipelineId}/advance`, { method: "POST" });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? `Advance failed (${res.status})`);
        return;
      }
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <StageShell
      title="Copy"
      subtitle={`Author at least ${MIN_APPROVED_COPY} approved copy variants per creative.`}
      canContinue={allHaveEnough && !busy}
      onContinue={advance}
      body={
        <div className="space-y-6">
          {inScope.length === 0 ? (
            <p className="rounded-md border border-dashed bg-muted/30 px-4 py-8 text-center text-sm text-muted-foreground">
              No creatives in scope for copy.
            </p>
          ) : (
            inScope.map((c) => (
              <CopyComposer
                key={c.id}
                pipelineId={pipelineId}
                creativeId={c.id}
                creativeLabel={c.concept ?? "Untitled concept"}
                variants={byCreative.get(c.id) ?? []}
                suggestions={suggestions}
                minApproved={MIN_APPROVED_COPY}
              />
            ))
          )}
          {error ? (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          ) : null}
        </div>
      }
    />
  );
}
