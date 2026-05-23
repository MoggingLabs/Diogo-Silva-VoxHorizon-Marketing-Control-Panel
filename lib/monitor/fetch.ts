import "server-only";

import type { PerfRow } from "@/lib/monitor/thresholds";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Server-side fetch for the MonitorDashboard (#362). Pulls the image perf rows
 * linked to a pipeline (via the `campaign_perf_image.pipeline_id` link added in
 * 0023). RLS is deny-all on the new tables, so this runs with the service-role
 * client in a Server Component only.
 */
export async function getMonitorRows(pipelineId: string): Promise<PerfRow[]> {
  const supabase = createAdminClient();
  const { data } = await supabase
    .from("campaign_perf_image")
    .select("campaign_id, spend, leads_ghl, leads_meta, ctr, freq, cpl_real, verdict")
    .eq("pipeline_id", pipelineId)
    .order("pulled_at", { ascending: false });
  return (data ?? []) as PerfRow[];
}
