import { MetricBadge } from "./MetricBadge";
import {
  compareByAttention,
  formatCurrency,
  formatPercent,
  type AuditFormat,
  type AuditRow,
} from "@/lib/audit";
import { cn } from "@/lib/utils";

export type AttentionCardsProps = {
  rows: AuditRow[];
  format: AuditFormat;
};

/**
 * "Headline metric" for a row — the single number the operator should glance
 * at first. For image rows that's CPL; for video it's hook rate. Returned as
 * a `{ label, value }` pair so the card can render both lines verbatim.
 */
function headlineMetric(row: AuditRow): { label: string; value: string } {
  if (row.format === "video") {
    return { label: "Hook rate", value: formatPercent(row.hook_rate) };
  }
  return { label: "CPL", value: formatCurrency(row.cpl_real) };
}

/**
 * Tiny inline spark — a 7-segment placeholder bar whose height is derived
 * from spend. The Wave 4 spec calls for a true 7-day trend, but that data
 * shape doesn't exist yet (the daily upsert lands one row/day, so the trend
 * is essentially `[spend]`). This component keeps the visual surface so the
 * later wire-up only needs to swap the data, not the layout.
 */
function MiniSpark({
  spend,
  severity,
}: {
  spend: number;
  severity: "kill" | "watch" | "keep" | null;
}) {
  const segments = 7;
  const normalized = Math.min(1, spend / 200); // 200 = full bar
  const colorClass =
    severity === "kill"
      ? "bg-destructive/50"
      : severity === "watch"
        ? "bg-warning/50"
        : "bg-success/50";

  return (
    <div className="flex h-8 items-end gap-0.5" aria-hidden="true">
      {Array.from({ length: segments }).map((_, i) => {
        // Crude faux-trend: ramp toward the right.
        const heightPct = Math.max(0.1, normalized * ((i + 1) / segments));
        return (
          <span
            key={i}
            className={cn("w-1 rounded-sm", colorClass)}
            style={{ height: `${heightPct * 100}%` }}
          />
        );
      })}
    </div>
  );
}

/**
 * Top-5 cards sorted by attention (severity desc, then spend desc). Each card
 * clicks through to the in-page table anchor — keeps the page single-screen
 * while still letting the operator drill in.
 */
export function AttentionCards({ rows, format }: AttentionCardsProps) {
  const sorted = [...rows].sort(compareByAttention).slice(0, 5);
  const hasUrgent = sorted.some((r) => r.verdict === "kill" || r.verdict === "watch");

  if (rows.length === 0) {
    return (
      <section className="rounded-lg border border-border bg-card p-6 text-sm text-muted-foreground shadow-sm">
        No campaigns to surface yet. The daily audit cron (M4-8) will populate cards once the worker
        is connected.
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between">
        <h2 className="text-lg font-semibold">Needs attention</h2>
        <span className="text-xs text-muted-foreground">
          {hasUrgent
            ? `Showing ${sorted.length} of ${rows.length}, sorted by severity then spend.`
            : `All ${rows.length} healthy. Showing top by spend.`}
        </span>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5">
        {sorted.map((row) => {
          const headline = headlineMetric(row);
          return (
            <a
              key={`${row.format}:${row.id}`}
              href={`#row-${row.format}-${row.id}`}
              className={cn(
                "group flex flex-col gap-3 rounded-lg border border-border bg-card p-4 shadow-sm",
                "transition-shadow transition-transform hover:-translate-y-0.5 hover:shadow-md",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              )}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex flex-col gap-0.5">
                  <span className="font-mono text-xs text-muted-foreground">
                    {row.format.toUpperCase()}
                    {format === "combined" ? "" : ""}
                    {" · "}
                    {row.window_days}d
                  </span>
                  <span
                    className="line-clamp-1 text-sm font-medium tabular-nums"
                    title={row.campaign_id}
                  >
                    {row.campaign_id}
                  </span>
                </div>
                <MetricBadge verdict={row.verdict} reason={row.verdict_reason} />
              </div>

              <div className="flex items-end justify-between gap-2">
                <div className="flex flex-col gap-0.5">
                  <span className="text-xs text-muted-foreground">{headline.label}</span>
                  <span className="text-2xl font-semibold tabular-nums">{headline.value}</span>
                </div>
                <MiniSpark spend={row.spend ?? 0} severity={row.verdict} />
              </div>

              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>Spend</span>
                <span className="tabular-nums">{formatCurrency(row.spend)}</span>
              </div>
            </a>
          );
        })}
      </div>
    </section>
  );
}
