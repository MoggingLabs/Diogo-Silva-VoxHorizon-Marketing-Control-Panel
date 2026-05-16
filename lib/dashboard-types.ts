import type { Database } from "@/lib/supabase/types.gen";

/**
 * Shared types + presentation metadata for the dashboard funnel + Kanban.
 *
 * Lives outside `lib/dashboard.ts` because that module is `server-only` (it
 * queries Supabase server-side) but client components like the format toggle
 * and Kanban board need the same types/constants for their props + styling.
 */

// ---------------------------------------------------------------------------
// Format toggle
// ---------------------------------------------------------------------------

export const FORMAT_VALUES = ["image", "video", "both"] as const;
export type DashboardFormat = (typeof FORMAT_VALUES)[number];

export const DEFAULT_FORMAT: DashboardFormat = "both";

export function parseFormat(raw: string | undefined | null): DashboardFormat {
  if (raw === "image" || raw === "video" || raw === "both") return raw;
  return DEFAULT_FORMAT;
}

// ---------------------------------------------------------------------------
// Funnel stages
// ---------------------------------------------------------------------------

/** Lifecycle stage names that match the funnel + Kanban column ordering. */
export const FUNNEL_STAGES = [
  "in_brief",
  "in_creative",
  "in_copy",
  "in_launch",
  "live",
  "killed",
] as const;
export type FunnelStage = (typeof FUNNEL_STAGES)[number];

/** Counts keyed by funnel stage. All numbers, defaulting to 0. */
export type FunnelCounts = Record<FunnelStage, number>;

export function zeroCounts(): FunnelCounts {
  return {
    in_brief: 0,
    in_creative: 0,
    in_copy: 0,
    in_launch: 0,
    live: 0,
    killed: 0,
  };
}

// ---------------------------------------------------------------------------
// Brief row payloads (shape returned by `lib/dashboard.ts:getDashboardSnapshot`)
// ---------------------------------------------------------------------------

/** Minimal client row joined with each brief/video-brief for card rendering. */
export type DashboardClient = {
  id: string;
  slug: string;
  name: string;
};

/** Kanban-card payload for image briefs. */
export type DashboardImageBrief = {
  id: string;
  brief_id_human: string;
  status: Database["public"]["Tables"]["briefs"]["Row"]["status"];
  created_at: string;
  posted_at: string | null;
  decided_at: string | null;
  client: DashboardClient | null;
};

/** Kanban-card payload for video briefs. */
export type DashboardVideoBrief = {
  id: string;
  brief_id_human: string;
  status: Database["public"]["Tables"]["video_briefs"]["Row"]["status"];
  created_at: string;
  posted_at: string | null;
  decided_at: string | null;
  client: DashboardClient | null;
};

export type DashboardSnapshot = {
  format: DashboardFormat;
  counts: {
    image: FunnelCounts;
    video: FunnelCounts;
    combined: FunnelCounts;
  };
  image_briefs: DashboardImageBrief[];
  video_briefs: DashboardVideoBrief[];
  errors: { image?: string; video?: string };
};

// ---------------------------------------------------------------------------
// Presentation metadata — shared between FunnelHeader, StackedBar, KanbanBoard
// ---------------------------------------------------------------------------

export const STAGE_LABELS: Record<FunnelStage, string> = {
  in_brief: "In Brief",
  in_creative: "In Creative",
  in_copy: "In Copy",
  in_launch: "In Launch",
  live: "Live",
  killed: "Killed",
};

/**
 * Tailwind background classes for each stage. Used by both the stacked bar
 * segments and the tile accent. The progression goes neutral → cool → warm →
 * green to convey "moving down the funnel toward live".
 */
export const STAGE_BAR_COLORS: Record<FunnelStage, string> = {
  in_brief: "bg-zinc-300",
  in_creative: "bg-indigo-400",
  in_copy: "bg-amber-400",
  in_launch: "bg-sky-400",
  live: "bg-emerald-500",
  killed: "bg-rose-400",
};

export const STAGE_DOT_COLORS: Record<FunnelStage, string> = {
  in_brief: "bg-zinc-400",
  in_creative: "bg-indigo-500",
  in_copy: "bg-amber-500",
  in_launch: "bg-sky-500",
  live: "bg-emerald-600",
  killed: "bg-rose-500",
};

/**
 * The 5 lifecycle stages we render in the Kanban view, in column order. Note
 * `killed` lives in the funnel header (a terminal counter) but is not its own
 * Kanban column — killed briefs are filtered out of the active board.
 */
export const KANBAN_STAGES: readonly FunnelStage[] = [
  "in_brief",
  "in_creative",
  "in_copy",
  "in_launch",
  "live",
] as const;
