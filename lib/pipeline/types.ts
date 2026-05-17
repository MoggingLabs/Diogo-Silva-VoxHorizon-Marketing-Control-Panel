/**
 * Pipeline lifecycle types — hand-rolled while Agent A's schema/migration
 * lands. Mirrors the row shape that `db/migrations/0006_pipelines.sql` will
 * introduce.
 *
 * TODO: swap to `types.gen.ts Database['public']['Tables']['pipelines']['Row']`
 * after #171 (the schema + types regen) lands. The local typings here exist
 * only so the UI shell can compile against an agreed contract before the
 * generated types are present.
 */

export type PipelineStatus =
  | "configuration"
  | "ideation"
  | "review"
  | "generation"
  | "done"
  | "cancelled";

export type PipelineFormat = "image" | "video" | "both";

export type Pipeline = {
  id: string;
  status: PipelineStatus;
  format_choice: PipelineFormat;
  client_id: string | null;
  image_brief_id: string | null;
  video_brief_id: string | null;
  config_draft: Record<string, unknown> | null;
  picks: { image?: string[]; video?: string[] } | null;
  cost_estimate: { items: unknown[]; total: number } | null;
  cost_actual: { items: unknown[]; total: number } | null;
  approval: { decision: string; notes?: string; decided_at: string } | null;
  launch_package_id: string | null;
  created_at: string;
  updated_at: string;
  advanced_at: Record<string, string> | null;
};

export type PipelineEvent = {
  id: string;
  pipeline_id: string;
  // 'stage_advanced' | 'task_queued' | 'task_running' | 'task_done' | 'task_error' | 'cost_recorded'
  kind: string;
  stage: PipelineStatus | null;
  payload: Record<string, unknown>;
  created_at: string;
};

/**
 * Five "happy-path" pipeline stages shown in the horizontal stepper. The
 * `cancelled` status is a terminal state outside the linear flow and is
 * surfaced separately in the detail page chrome.
 */
export const PIPELINE_STAGES: ReadonlyArray<{ key: PipelineStatus; label: string }> = [
  { key: "configuration", label: "Configuration" },
  { key: "ideation", label: "Ideation" },
  { key: "review", label: "Review" },
  { key: "generation", label: "Generation" },
  { key: "done", label: "Done" },
] as const;

/**
 * Status badge styling, shared between the index list and the detail header.
 * Kept in sync with the brief/launch badge palette for visual consistency.
 */
export const PIPELINE_STATUS_LABEL: Record<PipelineStatus, string> = {
  configuration: "Configuration",
  ideation: "Ideation",
  review: "Review",
  generation: "Generation",
  done: "Done",
  cancelled: "Cancelled",
};

export const PIPELINE_STATUS_BADGE: Record<PipelineStatus, string> = {
  configuration: "bg-muted text-muted-foreground",
  ideation: "bg-sky-100 text-sky-900 dark:bg-sky-950/40 dark:text-sky-200",
  review: "bg-amber-100 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200",
  generation: "bg-violet-100 text-violet-900 dark:bg-violet-950/40 dark:text-violet-200",
  done: "bg-emerald-100 text-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200",
  cancelled: "bg-destructive/10 text-destructive",
};

export const PIPELINE_FORMAT_LABEL: Record<PipelineFormat, string> = {
  image: "Image",
  video: "Video",
  both: "Image + Video",
};

export const PIPELINE_FORMAT_BADGE: Record<PipelineFormat, string> = {
  image: "bg-sky-100 text-sky-900 dark:bg-sky-950/40 dark:text-sky-200",
  video: "bg-violet-100 text-violet-900 dark:bg-violet-950/40 dark:text-violet-200",
  both: "bg-emerald-100 text-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200",
};
