"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, ShieldAlert, XCircle } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  buildGridRows,
  launchPreconditions,
  launchReady,
  overriddenCreatives,
  type GridCreative,
  type LaunchCopyVariant,
  type StageStateRow,
} from "@/lib/review/grid";
import { cn } from "@/lib/utils";

/**
 * LaunchGate (#361, P4.6): the launch_handoff preconditions checklist + the
 * PAUSED-first confirm.
 *
 * Launch is disabled until ALL preconditions are green
 * (spec-pass ∧ compliance-clear ∧ ≥3 approved copy/creative, computed in
 * `lib/review/grid.ts`). The gate re-surfaces compliance overrides so the
 * manager sees what was released before committing. Approving requires two
 * explicit confirmations — PAUSED-first and "I reviewed the preconditions" —
 * before the POST to `/api/pipelines/[id]/launch/decision`, which re-derives the
 * preconditions server-side (the hard gate never trusts the client).
 *
 * `children` slot renders the read-only LaunchSummary above the gate.
 */
export type LaunchGateProps = {
  pipelineId: string;
  creatives: GridCreative[];
  states: StageStateRow[];
  copyVariants: LaunchCopyVariant[];
  /** Read-only launch summary (e.g. <LaunchSummary />). */
  children?: React.ReactNode;
};

export function LaunchGate({
  pipelineId,
  creatives,
  states,
  copyVariants,
  children,
}: LaunchGateProps) {
  const router = useRouter();
  const rows = buildGridRows(creatives, states);
  const preconditions = launchPreconditions(rows, copyVariants);
  const ready = launchReady(preconditions);
  const overrides = overriddenCreatives(rows);

  const [pausedFirst, setPausedFirst] = useState(false);
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canLaunch = ready && pausedFirst && ack && !busy;

  const launch = async () => {
    if (!canLaunch) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/pipelines/${pipelineId}/launch/decision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          decision: "approved",
          confirm_paused_first: true,
          acknowledge_preconditions: true,
        }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string; reason?: string };
        setError(data.reason ?? data.error ?? `Launch failed (${res.status})`);
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
    <div className="space-y-5" data-testid="launch-gate">
      {children}

      <section className="space-y-2 rounded-md border border-border p-4">
        <h3 className="text-sm font-semibold">Launch preconditions</h3>
        <ul className="space-y-1.5" data-testid="preconditions">
          {preconditions.map((p) => (
            <li
              key={p.id}
              data-testid={`precondition-${p.id}`}
              data-met={p.met ? "true" : "false"}
              className="flex items-start gap-2 text-sm"
            >
              {p.met ? (
                <CheckCircle2
                  aria-hidden="true"
                  className="mt-0.5 size-4 shrink-0 text-emerald-600"
                />
              ) : (
                <XCircle aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-rose-600" />
              )}
              <span className="flex-1">
                <span className={cn(p.met ? "text-foreground" : "font-medium text-rose-700")}>
                  {p.label}
                </span>
                <span className="block text-xs text-muted-foreground">{p.detail}</span>
              </span>
            </li>
          ))}
        </ul>
      </section>

      {overrides.length > 0 ? (
        <section
          data-testid="resurfaced-overrides"
          className="space-y-2 rounded-md border border-amber-300 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-950/20"
        >
          <h3 className="flex items-center gap-1.5 text-sm font-semibold text-amber-900 dark:text-amber-200">
            <ShieldAlert aria-hidden="true" className="size-4" />
            Compliance overrides in this launch ({overrides.length})
          </h3>
          <ul className="space-y-1 text-xs text-amber-900 dark:text-amber-200">
            {overrides.map((o) => (
              <li key={o.id}>
                <span className="font-medium">{o.concept ?? "Untitled concept"}</span>
                {o.note ? <span> — {o.note}</span> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="space-y-2 rounded-md border border-border p-4">
        <h3 className="text-sm font-semibold">Confirm launch</h3>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            data-testid="confirm-paused-first"
            checked={pausedFirst}
            onChange={(e) => setPausedFirst(e.target.checked)}
            disabled={!ready}
          />
          <span>
            I understand all Meta entities are created <strong>PAUSED first</strong>; no live spend
            starts from this gate.
          </span>
        </label>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            data-testid="acknowledge-preconditions"
            checked={ack}
            onChange={(e) => setAck(e.target.checked)}
            disabled={!ready}
          />
          <span>I reviewed the preconditions above.</span>
        </label>

        {error ? (
          <p role="alert" className="text-xs text-destructive" data-testid="launch-error">
            {error}
          </p>
        ) : null}

        <div className="flex items-center justify-between gap-3 pt-1">
          <span className="text-xs text-muted-foreground">
            {ready
              ? "All preconditions met."
              : "Launch is blocked until every precondition is green."}
          </span>
          <Button
            type="button"
            data-testid="launch-button"
            disabled={!canLaunch}
            aria-disabled={!canLaunch}
            onClick={launch}
          >
            {busy ? "Launching…" : "Launch (PAUSED-first)"}
          </Button>
        </div>
      </section>
    </div>
  );
}
