import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/lib/supabase/types.gen";

/**
 * Read-only access to the recorded Meta ad-entity graph (E5.1 / #595).
 *
 * `ad_entity` is worker/Meta-owned (the recorder model, migration 0022): the
 * operator creates the PAUSED-first campaign/adset/ad/creative graph via its MCP
 * and the worker records the ids here. Per the makeover guardrails this table is
 * READ-only from the dashboard (limited overlay edits go through the `overrides`
 * overlay, never raw edits). This helper just loads the graph for the launch
 * detail page so the operator can SEE what was recorded.
 */

export type AdEntityRow = Database["public"]["Tables"]["ad_entity"]["Row"];

/** Load the recorded ad entities for a launch package, parent-first. */
export async function getAdEntitiesForLaunch(launchPackageId: string): Promise<AdEntityRow[]> {
  const supabase = createAdminClient();
  const { data } = await supabase
    .from("ad_entity")
    .select("*")
    .eq("launch_package_id", launchPackageId)
    .order("created_at", { ascending: true });
  return (data ?? []) as AdEntityRow[];
}
