/**
 * Decision thresholds for the MonitorDashboard (#362, P4.7).
 *
 * The monitor stage reads live ad performance and recommends kill / watch /
 * keep per the agency's decision thresholds. The single hard rule of the
 * rebuild: **GHL is lead truth** — real CPL is computed from GHL leads, never
 * Meta's reported leads ("Real CPL = Meta spend ÷ GHL leads"). This module is
 * the pure logic the dashboard cards + threshold pills key off.
 *
 * No React, no IO — pure data in / data out (the `node` vitest project).
 */

/** The three-way verdict, matching `ad_verdict` in the DB. */
export type Verdict = "kill" | "watch" | "keep";

/** The manager's monitor action; "scale" is the positive counterpart to "kill". */
export type MonitorAction = "kill" | "scale";

/**
 * A perf row narrowed to what the threshold engine + KPI cards need. Mirrors
 * `campaign_perf_image` (spend, leads_ghl, leads_meta, ctr, freq, cpl_real).
 */
export type PerfRow = {
  campaign_id: string;
  spend: number | null;
  leads_ghl: number | null;
  leads_meta: number | null;
  ctr: number | null;
  freq: number | null;
  cpl_real: number | null;
  verdict?: Verdict | null;
};

/**
 * Same as `PerfRow`, plus the source row `id` so the operator-correction
 * overlay can be keyed on `(campaign_perf_image, id, field)`. Lives here (not
 * in `lib/monitor/fetch.ts`) because the client-side `MonitorDashboard`
 * imports it — `fetch.ts` is `server-only` and can't be reached from a
 * `"use client"` component.
 */
export type PerfRowWithId = PerfRow & { id: string };

/**
 * The Supabase table the perf overlay edits target (the `overrides.table_name`
 * key). Constant lives here so the client `MonitorDashboard` can pass it to
 * `EditableValue` without importing from the server-only fetch module.
 */
export const PERF_IMAGE_TABLE = "campaign_perf_image" as const;

/**
 * Decision thresholds. Defaults are the agency's published roofing/remodeling
 * monitor rules; a client's `cpl_target` overrides the CPL bands at call time.
 *   - CPL ≤ target          → keep
 *   - target < CPL ≤ target×`watchMultiplier` → watch
 *   - CPL > target×`killMultiplier` (or no leads after `minSpendForKill`) → kill
 *   - frequency over `freqCap` is a fatigue signal that downgrades keep→watch.
 */
export type DecisionThresholds = {
  cplTarget: number;
  watchMultiplier: number;
  killMultiplier: number;
  /** Spend (USD) past which zero GHL leads is an automatic kill. */
  minSpendForKill: number;
  /** Frequency above this downgrades a keep to a watch (creative fatigue). */
  freqCap: number;
};

export const DEFAULT_THRESHOLDS: DecisionThresholds = {
  cplTarget: 100,
  watchMultiplier: 1.25,
  killMultiplier: 1.5,
  minSpendForKill: 150,
  freqCap: 3,
};

/**
 * Real CPL from GHL truth: Meta spend ÷ GHL leads. Returns `null` when there
 * are no GHL leads yet (CPL is undefined, not "infinitely bad") so callers can
 * distinguish "no data" from "expensive". Never divides by Meta leads.
 */
export function realCpl(spend: number | null, leadsGhl: number | null): number | null {
  if (!spend || spend <= 0) return null;
  if (!leadsGhl || leadsGhl <= 0) return null;
  return spend / leadsGhl;
}

/**
 * Classify a single perf row to a verdict using GHL-truth CPL. The order of
 * checks encodes the decision tree:
 *   1. spent past the kill floor with zero GHL leads → kill (burning budget),
 *   2. CPL beyond the kill band → kill,
 *   3. CPL in the watch band, or frequency fatigue → watch,
 *   4. otherwise → keep.
 */
export function classify(
  row: PerfRow,
  thresholds: DecisionThresholds = DEFAULT_THRESHOLDS,
): Verdict {
  const { cplTarget, watchMultiplier, killMultiplier, minSpendForKill, freqCap } = thresholds;
  const spend = row.spend ?? 0;
  const leads = row.leads_ghl ?? 0;

  // 1. Spent real money with no GHL conversions → kill.
  if (spend >= minSpendForKill && leads <= 0) {
    return "kill";
  }

  const cpl = realCpl(row.spend, row.leads_ghl);

  // No CPL signal yet (no leads, under the kill floor) → watch, not keep.
  if (cpl === null) {
    return "watch";
  }

  // 2. CPL beyond the kill band.
  if (cpl > cplTarget * killMultiplier) {
    return "kill";
  }

  // 3. CPL in the watch band.
  if (cpl > cplTarget * watchMultiplier) {
    return "watch";
  }

  // 3b. Frequency fatigue downgrades an otherwise-keep to watch.
  if ((row.freq ?? 0) > freqCap) {
    return "watch";
  }

  // 4. Healthy.
  return "keep";
}

/** Tailwind tone classes per verdict, traffic-light style. */
export const VERDICT_TONE: Record<Verdict, string> = {
  keep: "bg-emerald-100 text-emerald-900 ring-emerald-300 dark:bg-emerald-950/40 dark:text-emerald-200 dark:ring-emerald-800",
  watch:
    "bg-amber-100 text-amber-900 ring-amber-300 dark:bg-amber-950/40 dark:text-amber-200 dark:ring-amber-800",
  kill: "bg-rose-100 text-rose-900 ring-rose-300 dark:bg-rose-950/40 dark:text-rose-200 dark:ring-rose-800",
};

export const VERDICT_LABEL: Record<Verdict, string> = {
  keep: "Keep",
  watch: "Watch",
  kill: "Kill",
};

export type MonitorKpis = {
  spend: number;
  leadsGhl: number;
  leadsMeta: number;
  /** Blended real CPL across the rows (total spend ÷ total GHL leads). */
  blendedCpl: number | null;
  /** Spread between GHL and Meta lead counts (over-reporting signal). */
  leadGap: number;
  campaigns: number;
};

/** Sum a numeric field across rows, treating null as 0. */
function sum(rows: PerfRow[], pick: (r: PerfRow) => number | null): number {
  return rows.reduce((acc, r) => acc + (pick(r) ?? 0), 0);
}

/**
 * Roll the per-campaign rows up into the dashboard KPI cards. `blendedCpl` is
 * the GHL-truth blended cost-per-lead; `leadGap` surfaces how much Meta
 * over-reports leads vs GHL (the reason for the permanent GHL-truth banner).
 */
export function summarizeKpis(rows: PerfRow[]): MonitorKpis {
  const spend = sum(rows, (r) => r.spend);
  const leadsGhl = sum(rows, (r) => r.leads_ghl);
  const leadsMeta = sum(rows, (r) => r.leads_meta);
  return {
    spend,
    leadsGhl,
    leadsMeta,
    blendedCpl: realCpl(spend, leadsGhl),
    leadGap: leadsMeta - leadsGhl,
    campaigns: rows.length,
  };
}
