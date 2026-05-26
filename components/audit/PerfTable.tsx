"use client";

import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";

import { MetricBadge } from "./MetricBadge";
import {
  formatCurrency,
  formatDecimal,
  formatNumber,
  formatPercent,
  formatSeconds,
  totalLeads,
  type AuditFormat,
  type AuditRow,
} from "@/lib/audit";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Column model
// ---------------------------------------------------------------------------

type ColumnId =
  | "campaign"
  | "format"
  | "window"
  | "spend"
  | "ctr"
  | "freq"
  | "leads"
  | "cpl"
  | "hook_rate"
  | "drop_off_3s"
  | "watch_time_p50"
  | "verdict";

type Column = {
  id: ColumnId;
  label: string;
  align?: "left" | "right";
  /** Returns the sort key. `null` → sorts last. */
  sortKey: (row: AuditRow) => number | string | null;
  /** Returns the rendered cell content. */
  render: (row: AuditRow) => React.ReactNode;
};

const COL_CAMPAIGN: Column = {
  id: "campaign",
  label: "Campaign",
  align: "left",
  sortKey: (r) => r.campaign_id,
  render: (r) => (
    <span className="font-mono text-xs" title={r.campaign_id}>
      {r.campaign_id}
    </span>
  ),
};

const COL_FORMAT: Column = {
  id: "format",
  label: "Format",
  align: "left",
  sortKey: (r) => r.format,
  render: (r) => <span className="text-xs uppercase text-muted-foreground">{r.format}</span>,
};

const COL_WINDOW: Column = {
  id: "window",
  label: "Win.",
  align: "right",
  sortKey: (r) => r.window_days,
  render: (r) => <span className="text-xs tabular-nums">{r.window_days}d</span>,
};

const COL_SPEND: Column = {
  id: "spend",
  label: "Spend",
  align: "right",
  sortKey: (r) => r.spend,
  render: (r) => <span className="tabular-nums">{formatCurrency(r.spend)}</span>,
};

const COL_CTR: Column = {
  id: "ctr",
  label: "CTR",
  align: "right",
  sortKey: (r) => r.ctr,
  render: (r) => <span className="tabular-nums">{formatPercent(r.ctr)}</span>,
};

const COL_FREQ: Column = {
  id: "freq",
  label: "Freq.",
  align: "right",
  sortKey: (r) => r.freq,
  render: (r) => <span className="tabular-nums">{formatDecimal(r.freq, 2)}</span>,
};

const COL_LEADS: Column = {
  id: "leads",
  label: "Leads",
  align: "right",
  sortKey: (r) => totalLeads(r),
  render: (r) => <span className="tabular-nums">{formatNumber(totalLeads(r))}</span>,
};

const COL_CPL: Column = {
  id: "cpl",
  label: "CPL",
  align: "right",
  sortKey: (r) => r.cpl_real,
  render: (r) => <span className="tabular-nums">{formatCurrency(r.cpl_real)}</span>,
};

const COL_HOOK: Column = {
  id: "hook_rate",
  label: "Hook",
  align: "right",
  sortKey: (r) => r.hook_rate,
  render: (r) => <span className="tabular-nums">{formatPercent(r.hook_rate)}</span>,
};

const COL_DROP_OFF: Column = {
  id: "drop_off_3s",
  label: "Drop-off",
  align: "right",
  sortKey: (r) => r.drop_off_3s,
  render: (r) => <span className="tabular-nums">{formatPercent(r.drop_off_3s)}</span>,
};

const COL_WATCH_P50: Column = {
  id: "watch_time_p50",
  label: "p50",
  align: "right",
  sortKey: (r) => r.watch_time_p50,
  render: (r) => <span className="tabular-nums">{formatSeconds(r.watch_time_p50)}</span>,
};

const COL_VERDICT: Column = {
  id: "verdict",
  label: "Verdict",
  align: "left",
  // Use severity here so the column sorts kill → watch → keep.
  sortKey: (r) => {
    if (r.verdict === "kill") return 2;
    if (r.verdict === "watch") return 1;
    if (r.verdict === "keep") return 0;
    return -1;
  },
  render: (r) => <MetricBadge verdict={r.verdict} reason={r.verdict_reason} />,
};

function columnsFor(format: AuditFormat): Column[] {
  const common: Column[] = [COL_CAMPAIGN];
  if (format === "combined") common.push(COL_FORMAT);
  common.push(COL_WINDOW, COL_SPEND, COL_CTR, COL_FREQ, COL_LEADS, COL_CPL);
  if (format === "video" || format === "combined") {
    common.push(COL_HOOK, COL_DROP_OFF, COL_WATCH_P50);
  }
  common.push(COL_VERDICT);
  return common;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export type PerfTableProps = {
  rows: AuditRow[];
  format: AuditFormat;
};

type SortDir = "asc" | "desc";

function compareKeys(
  a: ReturnType<Column["sortKey"]>,
  b: ReturnType<Column["sortKey"]>,
  dir: SortDir,
): number {
  // Nulls sort last regardless of direction so empty cells stay at the bottom.
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return 1 * -1; // null on `b` → b goes after, but we want nulls last on both
  const cmp =
    typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b));
  return dir === "asc" ? cmp : -cmp;
}

/**
 * Sortable performance table. Default sort is spend desc. Click a header to
 * cycle sort dir. Combined view hides video-only columns when the row is an
 * image (rendered as `—`).
 *
 * Built with a plain `<table>` + Tailwind — adding `@tanstack/react-table`
 * would be overkill for this volume.
 */
export function PerfTable({ rows, format }: PerfTableProps) {
  const columns = useMemo(() => columnsFor(format), [format]);
  const [sortBy, setSortBy] = useState<ColumnId>("spend");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  const sorted = useMemo(() => {
    const col = columns.find((c) => c.id === sortBy) ?? columns[0];
    if (!col) return rows;
    return [...rows].sort((a, b) => compareKeys(col.sortKey(a), col.sortKey(b), sortDir));
  }, [columns, rows, sortBy, sortDir]);

  function clickHeader(id: ColumnId) {
    if (sortBy === id) {
      setSortDir(sortDir === "asc" ? "desc" : "asc");
    } else {
      setSortBy(id);
      // Most columns are most useful sorted desc by default; pivot to asc for
      // the campaign / format text columns where alphabetic order is friendlier.
      setSortDir(id === "campaign" || id === "format" ? "asc" : "desc");
    }
  }

  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-card p-6 text-sm text-muted-foreground shadow-sm">
        No performance rows yet for this filter. Adjust the format tab or window, or wait for the
        next audit pull.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-card shadow-sm">
      <table className="w-full min-w-[720px] text-sm">
        <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
          <tr>
            {columns.map((col) => {
              const isActive = sortBy === col.id;
              const ariaSort: "ascending" | "descending" | "none" = isActive
                ? sortDir === "asc"
                  ? "ascending"
                  : "descending"
                : "none";
              return (
                <th
                  key={col.id}
                  scope="col"
                  aria-sort={ariaSort}
                  className={cn("px-3 py-2 font-medium", col.align === "right" && "text-right")}
                >
                  <button
                    type="button"
                    onClick={() => clickHeader(col.id)}
                    className={cn(
                      "-mx-1 inline-flex items-center gap-1 rounded px-1 py-0.5 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      col.align === "right" && "flex-row-reverse",
                      isActive && "text-foreground",
                    )}
                  >
                    {col.label}
                    {isActive ? (
                      sortDir === "asc" ? (
                        <ArrowUp className="h-3 w-3" aria-hidden="true" />
                      ) : (
                        <ArrowDown className="h-3 w-3" aria-hidden="true" />
                      )
                    ) : (
                      <ChevronsUpDown className="h-3 w-3 opacity-40" aria-hidden="true" />
                    )}
                  </button>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => (
            <tr
              key={`${row.format}:${row.id}`}
              id={`row-${row.format}-${row.id}`}
              className="scroll-mt-20 border-t hover:bg-muted/30"
            >
              {columns.map((col) => (
                <td key={col.id} className={cn("px-3 py-2", col.align === "right" && "text-right")}>
                  {col.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
