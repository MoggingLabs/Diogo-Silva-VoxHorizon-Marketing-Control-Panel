/**
 * Audit page types + helpers + verdict thresholds.
 *
 * Mirrors the worker's verdict module (`worker/src/services/verdict.py` +
 * `verdict_video.py`) so the operator-facing UI can format thresholds and
 * tooltip copy without an extra round-trip. Keep the constants in sync with
 * the Python side when the spec changes — there's a duplicate-tests strategy
 * on both sides that will surface drift.
 *
 * This module is intentionally framework-agnostic — it does not import any
 * `server-only` symbols — so client components like the format tabs and the
 * traffic-light badge can import it safely.
 */

import type { Database } from "@/lib/supabase/types.gen";

// ---------------------------------------------------------------------------
// Verdict enum + types
// ---------------------------------------------------------------------------

export const VERDICT_VALUES = ["kill", "watch", "keep"] as const;
export type Verdict = (typeof VERDICT_VALUES)[number];

export type ImagePerfRow = Database["public"]["Tables"]["campaign_perf_image"]["Row"];
export type VideoPerfRow = Database["public"]["Tables"]["campaign_perf_video"]["Row"];
export type CombinedPerfRow = Database["public"]["Views"]["v_campaign_perf"]["Row"];

/** Format tab values for the audit page (`?format=`). */
export const AUDIT_FORMAT_VALUES = ["combined", "image", "video"] as const;
export type AuditFormat = (typeof AUDIT_FORMAT_VALUES)[number];
export const DEFAULT_AUDIT_FORMAT: AuditFormat = "combined";

export function parseAuditFormat(raw: string | undefined | null): AuditFormat {
  if (raw === "image" || raw === "video" || raw === "combined") return raw;
  return DEFAULT_AUDIT_FORMAT;
}

/** Window-day values shown on the audit page (`?window=`). */
export const AUDIT_WINDOW_VALUES = [1, 7, 30] as const;
export type AuditWindow = (typeof AUDIT_WINDOW_VALUES)[number];
export const DEFAULT_AUDIT_WINDOW: AuditWindow = 30;

export function parseAuditWindow(raw: string | undefined | null): AuditWindow {
  const n = Number.parseInt(raw ?? "", 10);
  if (n === 1 || n === 7 || n === 30) return n;
  return DEFAULT_AUDIT_WINDOW;
}

// ---------------------------------------------------------------------------
// Verdict thresholds (mirror of worker/src/services/verdict*.py)
// ---------------------------------------------------------------------------

/** Minimum days since launch before kill/watch rules apply. */
export const GRACE_PERIOD_DAYS = 2;

/** Spend above which zero leads becomes a hard kill. */
export const KILL_SPEND_WITHOUT_LEADS = 75;

/** CPL multiplier vs. client target that triggers a kill when leads = 0. */
export const KILL_CPL_MULTIPLIER = 1.5;

/** Frequency above which we flag (or kill, combined with low CTR). */
export const HIGH_FREQUENCY = 3.0;

/** CTR below which we flag as a watch. */
export const LOW_CTR = 0.01;

/** CTR above which we flag as a strong creative. */
export const STRONG_CTR = 0.02;

/** Hook-rate floor for video (3s viewers / impressions). */
export const LOW_HOOK_RATE = 0.2;

/** Drop-off rate after 3s above which we flag. */
export const HIGH_DROP_OFF_3S = 0.8;

/** Median watch time below which we flag as "very low watch time". */
export const LOW_WATCH_TIME_P50_S = 5;

// ---------------------------------------------------------------------------
// Verdict severity (used for sorting + cards)
// ---------------------------------------------------------------------------

/**
 * Numeric severity used to sort "needs attention first". Higher = more urgent.
 * `null` verdicts come last (treated as 0).
 */
export const VERDICT_SEVERITY: Record<Verdict, number> = {
  kill: 2,
  watch: 1,
  keep: 0,
};

export function severityFor(verdict: Verdict | null): number {
  if (verdict === null) return -1;
  return VERDICT_SEVERITY[verdict];
}

// ---------------------------------------------------------------------------
// Combined / format-aware row helpers
// ---------------------------------------------------------------------------

/**
 * Unified row shape the audit page renders, regardless of source table.
 *
 * When fetched from the `v_campaign_perf` view we get the common subset; the
 * video-only columns are filled in via a parallel query keyed on `id` so the
 * combined table can still show hook_rate / drop_off when applicable.
 */
export type AuditRow = {
  id: string;
  client_id: string | null;
  campaign_id: string;
  window_days: number;
  format: "image" | "video";
  spend: number | null;
  impressions: number | null;
  clicks: number | null;
  ctr: number | null;
  leads_meta: number | null;
  leads_ghl: number | null;
  cpl_real: number | null;
  freq: number | null;
  /** Video-only — null for image rows. */
  hook_rate: number | null;
  /** Video-only — null for image rows. */
  drop_off_3s: number | null;
  /** Video-only — null for image rows. */
  view_rate_avg: number | null;
  /** Video-only — null for image rows. */
  watch_time_p50: number | null;
  verdict: Verdict | null;
  verdict_reason: string | null;
  pulled_at: string;
};

export function imageRowToAuditRow(r: ImagePerfRow): AuditRow {
  return {
    id: r.id,
    client_id: r.client_id,
    campaign_id: r.campaign_id,
    window_days: r.window_days,
    format: "image",
    spend: r.spend,
    impressions: r.impressions,
    clicks: r.clicks,
    ctr: r.ctr,
    leads_meta: r.leads_meta,
    leads_ghl: r.leads_ghl,
    cpl_real: r.cpl_real,
    freq: r.freq,
    hook_rate: null,
    drop_off_3s: null,
    view_rate_avg: null,
    watch_time_p50: null,
    verdict: r.verdict,
    verdict_reason: r.verdict_reason,
    pulled_at: r.pulled_at,
  };
}

export function videoRowToAuditRow(r: VideoPerfRow): AuditRow {
  return {
    id: r.id,
    client_id: r.client_id,
    campaign_id: r.campaign_id,
    window_days: r.window_days,
    format: "video",
    spend: r.spend,
    impressions: r.impressions,
    clicks: r.clicks,
    ctr: r.ctr,
    leads_meta: r.leads_meta,
    leads_ghl: r.leads_ghl,
    cpl_real: r.cpl_real,
    freq: r.freq,
    hook_rate: r.hook_rate,
    drop_off_3s: r.drop_off_3s,
    view_rate_avg: r.view_rate_avg,
    watch_time_p50: r.watch_time_p50,
    verdict: r.verdict,
    verdict_reason: r.verdict_reason,
    pulled_at: r.pulled_at,
  };
}

/**
 * Sum the leads columns. Treats nulls as zero so the cards/sankey can render
 * cleanly with sparse data.
 */
export function totalLeads(row: Pick<AuditRow, "leads_meta" | "leads_ghl">): number {
  return (row.leads_meta ?? 0) + (row.leads_ghl ?? 0);
}

/**
 * Sort rows by "needs attention first": severity desc, then spend desc, then
 * pulled_at desc. Used by both the Top-5 cards and the default table order.
 */
export function compareByAttention(a: AuditRow, b: AuditRow): number {
  const dv = severityFor(b.verdict) - severityFor(a.verdict);
  if (dv !== 0) return dv;
  const ds = (b.spend ?? 0) - (a.spend ?? 0);
  if (ds !== 0) return ds;
  return b.pulled_at.localeCompare(a.pulled_at);
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

export function formatCurrency(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return `$${value.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

export function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return `${(value * 100).toFixed(2)}%`;
}

export function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return value.toLocaleString();
}

export function formatDecimal(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined) return "—";
  return value.toFixed(digits);
}

export function formatSeconds(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return `${value.toFixed(1)}s`;
}

// ---------------------------------------------------------------------------
// Funnel / Sankey helpers
// ---------------------------------------------------------------------------

/**
 * Stage IDs for the audit funnel Sankey. Booked/showed/sold are placeholders
 * for the Wave 5 booking integration; for now they always render as zero.
 */
export const FUNNEL_STAGES = [
  "impressions",
  "clicks",
  "leads",
  "booked",
  "showed",
  "sold",
] as const;
export type FunnelStageId = (typeof FUNNEL_STAGES)[number];

export const FUNNEL_STAGE_LABELS: Record<FunnelStageId, string> = {
  impressions: "Impressions",
  clicks: "Clicks",
  leads: "Leads",
  booked: "Booked",
  showed: "Showed",
  sold: "Sold",
};

export type FunnelTotals = Record<FunnelStageId, number>;

export function zeroFunnelTotals(): FunnelTotals {
  return {
    impressions: 0,
    clicks: 0,
    leads: 0,
    booked: 0,
    showed: 0,
    sold: 0,
  };
}

export function aggregateFunnel(rows: AuditRow[]): FunnelTotals {
  const totals = zeroFunnelTotals();
  for (const r of rows) {
    totals.impressions += r.impressions ?? 0;
    totals.clicks += r.clicks ?? 0;
    totals.leads += totalLeads(r);
    // booked/showed/sold come from the GHL integration (Wave 5+), not the
    // performance table — leave as zero for now.
  }
  return totals;
}
