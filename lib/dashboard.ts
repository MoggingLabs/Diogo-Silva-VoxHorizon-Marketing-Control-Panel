import "server-only";

import {
  zeroCounts,
  type DashboardClient,
  type DashboardFormat,
  type DashboardImageBrief,
  type DashboardSnapshot,
  type DashboardVideoBrief,
  type FunnelCounts,
} from "@/lib/dashboard-types";
import { createClient } from "@/lib/supabase/server";

/**
 * Server-only dashboard data layer.
 *
 * Composes funnel-header counts + the Kanban-board row payload off of the
 * brief / video_brief lifecycle data already in Supabase.
 *
 * Wave 2 wires the lifecycle stage we have data for (`in_brief`); the later
 * stages (`in_creative`, `in_copy`, `in_launch`, `live`, `killed`) get
 * placeholder counts here and are filled in by M2/M3/V2/V3 when their tables
 * get rows. Shared types + presentation metadata live in `lib/dashboard-types`
 * so client components can import them without dragging the `server-only`
 * dependency into the browser bundle.
 */

/**
 * Statuses that map to the `in_brief` funnel stage. `approved` and
 * `approved_with_changes` are technically "approved" but they still live in the
 * Brief column until creatives get generated downstream (M2+).
 */
const IN_BRIEF_STATUSES = ["draft", "posted", "approved", "approved_with_changes"] as const;

type ClientJoinRow = {
  id: string;
  slug: string;
  name: string;
};

function pickClient(joined: unknown): DashboardClient | null {
  if (!joined) return null;
  const row = Array.isArray(joined) ? joined[0] : (joined as ClientJoinRow);
  if (!row) return null;
  const r = row as Partial<ClientJoinRow>;
  if (!r.id || !r.slug || !r.name) return null;
  return { id: r.id, slug: r.slug, name: r.name };
}

function sumCounts(a: FunnelCounts, b: FunnelCounts): FunnelCounts {
  return {
    in_brief: a.in_brief + b.in_brief,
    in_creative: a.in_creative + b.in_creative,
    in_copy: a.in_copy + b.in_copy,
    in_launch: a.in_launch + b.in_launch,
    live: a.live + b.live,
    killed: a.killed + b.killed,
  };
}

/**
 * Fetches the dashboard snapshot for the requested format. Both tracks are
 * always queried (cheap counts) so the funnel-header `combined` tile is honest
 * regardless of which track is rendered; but only the requested track's row
 * payload is hydrated — when `format=image` we skip the video row fetch, etc.
 */
export async function getDashboardSnapshot(format: DashboardFormat): Promise<DashboardSnapshot> {
  const supabase = await createClient();
  const errors: { image?: string; video?: string } = {};

  const imageCounts = zeroCounts();
  const videoCounts = zeroCounts();

  const imageCountQ = await supabase
    .from("briefs")
    .select("id", { count: "exact", head: true })
    .in("status", [...IN_BRIEF_STATUSES]);
  if (imageCountQ.error) {
    errors.image = imageCountQ.error.message;
  } else {
    imageCounts.in_brief = imageCountQ.count ?? 0;
  }

  const videoCountQ = await supabase
    .from("video_briefs")
    .select("id", { count: "exact", head: true })
    .in("status", [...IN_BRIEF_STATUSES]);
  if (videoCountQ.error) {
    errors.video = videoCountQ.error.message;
  } else {
    videoCounts.in_brief = videoCountQ.count ?? 0;
  }

  let imageBriefs: DashboardImageBrief[] = [];
  let videoBriefs: DashboardVideoBrief[] = [];

  if (format === "image" || format === "both") {
    const q = await supabase
      .from("briefs")
      .select(
        "id, brief_id_human, status, created_at, posted_at, decided_at, clients(id, slug, name)",
      )
      .in("status", [...IN_BRIEF_STATUSES])
      .order("created_at", { ascending: false })
      .limit(200);
    if (q.error) {
      errors.image = q.error.message;
    } else {
      imageBriefs = (q.data ?? []).map((row) => ({
        id: row.id,
        brief_id_human: row.brief_id_human,
        status: row.status,
        created_at: row.created_at,
        posted_at: row.posted_at,
        decided_at: row.decided_at,
        client: pickClient(row.clients),
      }));
    }
  }

  if (format === "video" || format === "both") {
    const q = await supabase
      .from("video_briefs")
      .select(
        "id, brief_id_human, status, created_at, posted_at, decided_at, clients(id, slug, name)",
      )
      .in("status", [...IN_BRIEF_STATUSES])
      .order("created_at", { ascending: false })
      .limit(200);
    if (q.error) {
      errors.video = q.error.message;
    } else {
      videoBriefs = (q.data ?? []).map((row) => ({
        id: row.id,
        brief_id_human: row.brief_id_human,
        status: row.status,
        created_at: row.created_at,
        posted_at: row.posted_at,
        decided_at: row.decided_at,
        client: pickClient(row.clients),
      }));
    }
  }

  return {
    format,
    counts: {
      image: imageCounts,
      video: videoCounts,
      combined: sumCounts(imageCounts, videoCounts),
    },
    image_briefs: imageBriefs,
    video_briefs: videoBriefs,
    errors,
  };
}

// Re-export the shared types/constants so existing call sites (`@/lib/dashboard`)
// keep working — the public surface stays identical while the server-only
// boundary is internal.
export type {
  DashboardClient,
  DashboardFormat,
  DashboardImageBrief,
  DashboardSnapshot,
  DashboardVideoBrief,
  FunnelCounts,
  FunnelStage,
} from "@/lib/dashboard-types";
export {
  DEFAULT_FORMAT,
  FORMAT_VALUES,
  FUNNEL_STAGES,
  KANBAN_STAGES,
  parseFormat,
  STAGE_BAR_COLORS,
  STAGE_DOT_COLORS,
  STAGE_LABELS,
  zeroCounts,
} from "@/lib/dashboard-types";
