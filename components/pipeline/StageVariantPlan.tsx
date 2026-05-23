"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { StageShell } from "@/components/pipeline/StageShell";
import { Button } from "@/components/ui/button";

/**
 * Variant-plan stage host. The manager reviews the A/B test plan (one variable
 * per cell) and approves or rejects it; approval advances to finalize_assets.
 * Calls `/api/pipelines/[id]/variant-plan/decision`.
 */
export type VariantPlanCellView = {
  id: string;
  cell_index: number;
  label: string | null;
  creative_id: string | null;
  copy_variant_id: string | null;
};

export type StageVariantPlanProps = {
  pipelineId: string;
  testVariable: string | null;
  hypothesis: string | null;
  cells: VariantPlanCellView[];
};

export function StageVariantPlan({
  pipelineId,
  testVariable,
  hypothesis,
  cells,
}: StageVariantPlanProps) {
  const router = useRouter();
  const [busy, setBusy] = useState<"approved" | "rejected" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const decide = async (decision: "approved" | "rejected") => {
    let notes: string | undefined;
    if (decision === "rejected") {
      notes = typeof window !== "undefined" ? (window.prompt("Why reject the plan?") ?? "") : "";
      if (!notes.trim()) return;
    }
    setBusy(decision);
    setError(null);
    try {
      const res = await fetch(`/api/pipelines/${pipelineId}/variant-plan/decision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision, notes }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? `Request failed (${res.status})`);
        return;
      }
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
    } finally {
      setBusy(null);
    }
  };

  return (
    <StageShell
      title="Variant plan"
      subtitle="Review the A/B test matrix — one variable per cell — and approve to finalize."
      canContinue={false}
      body={
        <div className="space-y-4" data-testid="variant-plan">
          <dl className="grid gap-2 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                Test variable
              </dt>
              <dd className="capitalize">{testVariable ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-muted-foreground">Hypothesis</dt>
              <dd>{hypothesis ?? "—"}</dd>
            </div>
          </dl>

          {cells.length === 0 ? (
            <p className="rounded-md border border-dashed bg-muted/30 px-4 py-6 text-center text-sm text-muted-foreground">
              No test cells planned yet.
            </p>
          ) : (
            <ul className="grid gap-2 sm:grid-cols-2" data-testid="variant-cells">
              {cells.map((cell) => (
                <li
                  key={cell.id}
                  className="rounded-md border border-border px-3 py-2 text-sm"
                  data-testid={`cell-${cell.cell_index}`}
                >
                  <span className="font-semibold">Cell {cell.label ?? cell.cell_index}</span>
                  <span className="block text-xs text-muted-foreground">
                    creative {cell.creative_id?.slice(0, 8) ?? "—"} · copy{" "}
                    {cell.copy_variant_id?.slice(0, 8) ?? "—"}
                  </span>
                </li>
              ))}
            </ul>
          )}

          {error ? (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          ) : null}

          <div className="flex gap-2">
            <Button
              type="button"
              data-testid="approve-plan"
              disabled={busy !== null}
              onClick={() => decide("approved")}
            >
              {busy === "approved" ? "Approving…" : "Approve plan"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              data-testid="reject-plan"
              disabled={busy !== null}
              onClick={() => decide("rejected")}
            >
              Reject
            </Button>
          </div>
        </div>
      }
    />
  );
}
