"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ShieldAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { CreativeReviewGrid } from "@/components/review/CreativeReviewGrid";
import { SubStatePill } from "@/components/review/SubStatePill";
import {
  buildGridRows,
  rollupForStage,
  type GridCreative,
  type StageStateRow,
} from "@/lib/review/grid";
import { cn } from "@/lib/utils";

/**
 * ComplianceOverrideGate (#360, P4.5): the HARD compliance block + the audited
 * per-creative override.
 *
 * Compliance is a hard gate — the dashboard cannot advance while any creative
 * is `failed` without an audited override. Per blocked creative the manager can
 * open an override drawer requiring (a) a written justification and (b) a
 * type-to-confirm ("OVERRIDE") so the release is deliberate; the action POSTs to
 * `/api/pipelines/[id]/compliance/override` (owned by another agent) which
 * writes `overridden` + the required note (append-only audit). Past overrides
 * are shown inline as the permanent audit display.
 *
 * The Continue button is disabled until the compliance rollup clears (no failed
 * units remain) — matching the server `pipeline_rollup_cleared` gate.
 */
export type ComplianceOverrideGateProps = {
  pipelineId: string;
  creatives: GridCreative[];
  states: StageStateRow[];
  onOpenCreative?: (creativeId: string) => void;
  /** Advance to copy once compliance clears. */
  onContinue?: () => void;
};

const CONFIRM_WORD = "OVERRIDE";

export function ComplianceOverrideGate({
  pipelineId,
  creatives,
  states,
  onOpenCreative,
  onContinue,
}: ComplianceOverrideGateProps) {
  const router = useRouter();
  const rows = buildGridRows(creatives, states);
  const counts = rollupForStage(rows, "compliance_review");
  const blocked = rows.filter(
    (r) => r.creative.status !== "killed" && r.cells.compliance_review.status === "failed",
  );
  const overridden = rows.filter((r) => r.cells.compliance_review.status === "overridden");
  const cleared = counts.total > 0 && counts.blocked === 0;

  const [activeCreative, setActiveCreative] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = note.trim().length > 0 && confirm === CONFIRM_WORD && !busy;

  const submitOverride = async () => {
    if (!activeCreative || !canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/pipelines/${pipelineId}/compliance/override`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ creative_id: activeCreative, override_note: note.trim() }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? `Override failed (${res.status})`);
        return;
      }
      setActiveCreative(null);
      setNote("");
      setConfirm("");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4" data-testid="compliance-gate">
      {blocked.length > 0 ? (
        <div
          role="alert"
          data-testid="hard-block-banner"
          className="flex items-start gap-2 rounded-md border border-rose-300 bg-rose-50 px-4 py-3 text-sm text-rose-900 dark:border-rose-800 dark:bg-rose-950/30 dark:text-rose-200"
        >
          <ShieldAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <div>
            <p className="font-semibold">
              Compliance is a hard gate — {blocked.length} creative(s) blocked.
            </p>
            <p className="text-xs">
              Every blocked creative must pass or be overridden with a written justification before
              this run can continue.
            </p>
          </div>
        </div>
      ) : null}

      <CreativeReviewGrid
        creatives={creatives}
        states={states}
        mode="compliance_review"
        onOpenCreative={onOpenCreative}
      />

      {blocked.length > 0 ? (
        <section className="space-y-2" data-testid="blocked-list">
          <h3 className="text-sm font-semibold">Blocked creatives</h3>
          <ul className="space-y-2">
            {blocked.map((r) => (
              <li
                key={r.creative.id}
                className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-sm"
              >
                <span className="truncate">{r.creative.concept ?? "Untitled concept"}</span>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  data-testid={`override-open-${r.creative.id}`}
                  onClick={() => {
                    setActiveCreative(r.creative.id);
                    setNote("");
                    setConfirm("");
                    setError(null);
                  }}
                >
                  Override
                </Button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {activeCreative ? (
        <section
          data-testid="override-form"
          className="space-y-3 rounded-md border border-amber-300 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-950/20"
        >
          <h3 className="text-sm font-semibold text-amber-900 dark:text-amber-200">
            Override compliance block
          </h3>
          <label className="block text-xs font-medium" htmlFor="override-note">
            Justification (required)
          </label>
          <textarea
            id="override-note"
            data-testid="override-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Why is releasing this block acceptable?"
            className="min-h-[64px] w-full rounded-md border border-input bg-background px-2 py-1 text-sm"
          />
          <label className="block text-xs font-medium" htmlFor="override-confirm">
            Type <span className="font-mono font-semibold">{CONFIRM_WORD}</span> to confirm
          </label>
          <input
            id="override-confirm"
            data-testid="override-confirm"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            className="w-full rounded-md border border-input bg-background px-2 py-1 text-sm"
          />
          {error ? (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          ) : null}
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              variant="destructive"
              data-testid="override-submit"
              disabled={!canSubmit}
              onClick={submitOverride}
            >
              {busy ? "Overriding…" : "Confirm override"}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setActiveCreative(null)}>
              Cancel
            </Button>
          </div>
        </section>
      ) : null}

      {overridden.length > 0 ? (
        <section className="space-y-2" data-testid="override-audit">
          <h3 className="text-sm font-semibold">Override audit</h3>
          <ul className="space-y-1.5">
            {overridden.map((r) => (
              <li
                key={r.creative.id}
                className="flex items-start gap-2 rounded-md border border-border bg-card px-3 py-2 text-xs"
              >
                <SubStatePill status="overridden" />
                <div className="min-w-0">
                  <p className="truncate font-medium">{r.creative.concept ?? "Untitled concept"}</p>
                  {r.cells.compliance_review.note ? (
                    <p className="text-muted-foreground">{r.cells.compliance_review.note}</p>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <div className="flex items-center justify-end gap-3 border-t border-border pt-3">
        <span className="text-xs text-muted-foreground">
          {cleared
            ? "Compliance cleared for all creatives."
            : `${counts.blocked} blocked · ${counts.pending} pending`}
        </span>
        <Button
          type="button"
          data-testid="compliance-continue"
          disabled={!cleared}
          aria-disabled={!cleared}
          className={cn(!cleared && "cursor-not-allowed")}
          onClick={onContinue}
        >
          Continue to copy
        </Button>
      </div>
    </div>
  );
}
