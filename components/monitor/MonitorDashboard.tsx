"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Info, TrendingUp, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { EditableValue } from "@/components/ui/EditableValue";
import { StatusBadge } from "@/components/ui/StatusBadge";
import {
  classify,
  summarizeKpis,
  realCpl,
  PERF_IMAGE_TABLE,
  DEFAULT_THRESHOLDS,
  type DecisionThresholds,
  type PerfRowWithId,
  type Verdict,
} from "@/lib/monitor/thresholds";

/**
 * MonitorDashboard (#362, P4.7): KPI cards + per-campaign threshold pills + a
 * permanent GHL-truth banner + the kill/scale verdict actions.
 *
 * Every CPL shown is GHL-truth (Meta spend ÷ GHL leads); the banner makes that
 * explicit and surfaces the Meta-vs-GHL lead gap. Verdict pills colour each
 * campaign per the decision thresholds (`lib/monitor/thresholds.ts`). The
 * kill / scale buttons POST to `/api/pipelines/[id]/monitor/decision`.
 */
export type MonitorDashboardProps = {
  pipelineId: string;
  rows: PerfRowWithId[];
  /** Client CPL target overrides the default threshold band. */
  cplTarget?: number | null;
};

function money(n: number): string {
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

export function MonitorDashboard({ pipelineId, rows, cplTarget }: MonitorDashboardProps) {
  const router = useRouter();
  const thresholds: DecisionThresholds = cplTarget
    ? { ...DEFAULT_THRESHOLDS, cplTarget }
    : DEFAULT_THRESHOLDS;

  const kpis = summarizeKpis(rows);
  const [busy, setBusy] = useState<MonitorAction | null>(null);
  const [error, setError] = useState<string | null>(null);

  const decide = async (decision: MonitorAction) => {
    setBusy(decision);
    setError(null);
    try {
      const res = await fetch(`/api/pipelines/${pipelineId}/monitor/decision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision }),
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
    <div className="space-y-4" data-testid="monitor-dashboard">
      <div
        role="note"
        data-testid="ghl-truth-banner"
        className="flex items-start gap-2 rounded-md border border-info/40 bg-info/10 px-4 py-2 text-sm text-info"
      >
        <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        <p>
          <strong>GHL is lead truth.</strong> Real CPL = Meta spend ÷ GHL leads. Meta reported{" "}
          {kpis.leadsMeta} lead(s); GHL recorded {kpis.leadsGhl}
          {kpis.leadGap !== 0 ? ` (gap of ${kpis.leadGap})` : ""}.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <KpiCard label="Spend" value={money(kpis.spend)} />
        <KpiCard label="GHL leads" value={String(kpis.leadsGhl)} testid="kpi-leads-ghl" />
        <KpiCard
          label="Real CPL"
          value={kpis.blendedCpl === null ? "—" : money(kpis.blendedCpl)}
          testid="kpi-cpl"
        />
        <KpiCard label="Campaigns" value={String(kpis.campaigns)} />
      </div>

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full border-collapse text-sm" data-testid="monitor-table">
          <thead>
            <tr className="border-b border-border bg-muted/40 text-left">
              <th className="px-3 py-2 font-semibold">Campaign</th>
              <th className="px-3 py-2 font-semibold">Spend</th>
              <th className="px-3 py-2 font-semibold">GHL leads</th>
              <th className="px-3 py-2 font-semibold">Real CPL</th>
              <th className="px-3 py-2 font-semibold">Verdict</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-3 py-6 text-center text-muted-foreground">
                  No performance data yet. Pull leads from GHL to populate this view.
                </td>
              </tr>
            ) : (
              rows.map((row) => {
                const verdict: Verdict = classify(row, thresholds);
                const cpl = realCpl(row.spend, row.leads_ghl);
                return (
                  <tr
                    key={row.campaign_id}
                    data-testid={`monitor-row-${row.campaign_id}`}
                    className="border-b border-border last:border-0"
                  >
                    <td className="px-3 py-2 font-mono text-xs">{row.campaign_id}</td>
                    <td className="px-3 py-2">
                      <EditableValue
                        tableName={PERF_IMAGE_TABLE}
                        rowId={row.id}
                        field="spend"
                        type="number"
                        value={row.spend}
                        placeholder="0"
                        ariaLabel={`Correct spend for ${row.campaign_id}`}
                        onSaved={() => router.refresh()}
                      />
                    </td>
                    <td className="px-3 py-2">
                      <EditableValue
                        tableName={PERF_IMAGE_TABLE}
                        rowId={row.id}
                        field="leads_ghl"
                        type="number"
                        value={row.leads_ghl}
                        placeholder="0"
                        ariaLabel={`Correct GHL leads for ${row.campaign_id}`}
                        onSaved={() => router.refresh()}
                      />
                    </td>
                    <td className="px-3 py-2">{cpl === null ? "—" : money(cpl)}</td>
                    <td className="px-3 py-2">
                      <StatusBadge
                        status={verdict}
                        data-testid={`verdict-${row.campaign_id}`}
                        data-verdict={verdict}
                      />
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <p className="text-[11px] text-muted-foreground" data-testid="monitor-overlay-hint">
        Spend and GHL leads are worker-owned. Click a value to record an operator correction; the
        overlay never edits the source perf row.
      </p>

      {error ? (
        <p role="alert" className="text-xs text-destructive" data-testid="monitor-error">
          {error}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border pt-3">
        <Button
          type="button"
          variant="destructive"
          data-testid="kill-button"
          disabled={busy !== null}
          onClick={() => decide("kill")}
        >
          <Trash2 aria-hidden="true" className="size-4" />
          {busy === "kill" ? "Killing…" : "Kill"}
        </Button>
        <Button
          type="button"
          variant="success"
          data-testid="scale-button"
          disabled={busy !== null}
          onClick={() => decide("scale")}
        >
          <TrendingUp aria-hidden="true" className="size-4" />
          {busy === "scale" ? "Scaling…" : "Scale"}
        </Button>
      </div>
    </div>
  );
}

type MonitorAction = "kill" | "scale";

function KpiCard({ label, value, testid }: { label: string; value: string; testid?: string }) {
  return (
    <div data-testid={testid} className="rounded-lg border border-border bg-card px-3 py-2">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="text-lg font-semibold tabular-nums">{value}</p>
    </div>
  );
}
