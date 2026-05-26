import "server-only";

import type { PerfRow } from "@/lib/monitor/thresholds";
import { createAdminClient } from "@/lib/supabase/admin";

/** Table the perf overlay edits target (the overrides key `table_name`). */
export const PERF_IMAGE_TABLE = "campaign_perf_image" as const;

/**
 * A perf row carrying its source `id` so the operator-correction overlay can be
 * keyed on `(campaign_perf_image, id, field)`. The numeric fields already
 * reflect any operator override (the overlay is applied at read time — the
 * source row is never mutated, per the derived/worker-owned guardrail).
 */
export type PerfRowWithId = PerfRow & { id: string };

/**
 * Server-side fetch for the MonitorDashboard (#362). Pulls the image perf rows
 * linked to a pipeline (via the `campaign_perf_image.pipeline_id` link added in
 * 0023). RLS is deny-all on the new tables, so this runs with the service-role
 * client in a Server Component only.
 *
 * `campaign_perf_image` is DERIVED / worker-owned: the dashboard reads it and
 * allows ONLY single-field operator corrections via the `overrides` overlay
 * (never a raw edit of the source row). This fetch left-joins the overrides for
 * the rows it returns and applies any correction over the source value, so the
 * UI shows the corrected number while the source stays intact for re-ingest.
 */
export async function getMonitorRows(pipelineId: string): Promise<PerfRowWithId[]> {
  const supabase = createAdminClient();
  const { data } = await supabase
    .from("campaign_perf_image")
    .select("id, campaign_id, spend, leads_ghl, leads_meta, ctr, freq, cpl_real, verdict")
    .eq("pipeline_id", pipelineId)
    .order("pulled_at", { ascending: false });

  const rows = (data ?? []) as PerfRowWithId[];
  if (rows.length === 0) return rows;

  const { data: overrideRows } = await supabase
    .from("overrides")
    .select("row_id, field_name, corrected_value")
    .eq("table_name", PERF_IMAGE_TABLE)
    .in(
      "row_id",
      rows.map((r) => r.id),
    );

  return applyPerfOverrides(rows, overrideRows ?? []);
}

/** The numeric perf fields the operator overlay is allowed to correct. */
const OVERLAY_FIELDS = ["spend", "leads_ghl", "leads_meta", "ctr", "freq", "cpl_real"] as const;
type OverlayField = (typeof OVERLAY_FIELDS)[number];

type OverrideRow = { row_id: string; field_name: string; corrected_value: unknown };

/**
 * Apply operator-correction overrides over the source perf rows. Pure (no IO)
 * so it is unit-testable. Only the whitelisted numeric fields are overlaid; a
 * correction that doesn't parse to a finite number (or `null`) is ignored so a
 * malformed override can never corrupt the displayed KPIs.
 */
export function applyPerfOverrides(
  rows: PerfRowWithId[],
  overrides: OverrideRow[],
): PerfRowWithId[] {
  if (overrides.length === 0) return rows;
  const byRow = new Map<string, Map<string, unknown>>();
  for (const o of overrides) {
    if (!OVERLAY_FIELDS.includes(o.field_name as OverlayField)) continue;
    let fields = byRow.get(o.row_id);
    if (!fields) {
      fields = new Map();
      byRow.set(o.row_id, fields);
    }
    fields.set(o.field_name, o.corrected_value);
  }
  if (byRow.size === 0) return rows;

  return rows.map((row) => {
    const fields = byRow.get(row.id);
    if (!fields) return row;
    const next: PerfRowWithId = { ...row };
    for (const field of OVERLAY_FIELDS) {
      if (!fields.has(field)) continue;
      const value = coerceNumeric(fields.get(field));
      if (value !== undefined) {
        next[field] = value;
      }
    }
    return next;
  });
}

/** Coerce an override value to `number | null`; `undefined` = "ignore". */
function coerceNumeric(value: unknown): number | null | undefined {
  if (value === null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return null;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}
