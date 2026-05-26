import { NextResponse } from "next/server";

import { createAdminClient } from "@/lib/supabase/admin";
import {
  deriveDaemonFreshness,
  type DaemonFreshness,
  type WorkItemConsumer,
} from "@/lib/work-queue/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/operator/daemon-health
 *
 * Silent-failure PR-2a: reads the most-recent `work_item_consumers` row for
 * `kind='operator_dispatch'`. This is what `useDaemonHealth` hydrates from
 * on SSR; the same hook then re-derives `freshness` client-side as
 * `last_seen_at` ages out (so we don't need the route to compute it again
 * during a long-lived browser session).
 *
 * Response shape (matches what useDaemonHealth returns):
 *   { consumer: WorkItemConsumer | null, freshness: DaemonFreshness }
 *
 * - `consumer: null + freshness: 'down'` is returned when there is NO
 *   consumer row yet (the daemon has never booted on this stack). This is
 *   the correct red signal for the badge.
 * - The route is bearer-free (the dashboard reads via cookie session) and
 *   service-role under the hood so the deny-all RLS on `work_item_consumers`
 *   doesn't block it.
 */
export async function GET() {
  const supabase = createAdminClient();

  const { data, error } = await supabase
    .from("work_item_consumers")
    .select("*")
    .eq("kind", "operator_dispatch")
    .order("last_seen_at", { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const consumer = (data as WorkItemConsumer | null) ?? null;
  const freshness: DaemonFreshness = deriveDaemonFreshness(consumer);

  return NextResponse.json({ consumer, freshness });
}
