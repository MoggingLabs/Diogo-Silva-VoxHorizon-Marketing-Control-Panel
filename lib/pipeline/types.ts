/**
 * Pipeline lifecycle types.
 *
 * `PipelineStatus` / `PipelineFormat` are now derived from the generated
 * `lib/supabase/types.gen.ts` enums (E0.3 single-source-of-truth): the DB enums
 * are the source, `pnpm regen:types` reflects them into `types.gen.ts`, and
 * these aliases re-export them under the names the UI uses. If a stage is
 * added/removed in the DB, the exhaustive label/badge maps below stop type
 * checking — that is the drift signal.
 *
 * `Pipeline` / `PipelineEvent` stay curated view models (not the raw generated
 * `Row`s): the UI relies on the narrowed jsonb shapes here
 * (`config_draft` / `picks` / `cost_*` / `approval` / `advanced_at`) rather than
 * the generated `Json` columns. They mirror `db/migrations/0006_pipelines.sql`
 * but key their enum fields off the generated types so the status/format unions
 * cannot drift.
 */

import type { Database } from "@/lib/supabase/types.gen";

export type PipelineStatus = Database["public"]["Enums"]["pipeline_status_enum"];

export type PipelineFormat = Database["public"]["Enums"]["pipeline_format_enum"];

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
 * The happy-path pipeline stages shown in the stepper, in DAG order. The
 * `cancelled` status is a terminal escape outside the linear flow and is
 * surfaced separately in the detail page chrome. (P4's PhaseStepper clusters
 * these 12 into 5 phases for display; this flat list stays the source of order.)
 */
export const PIPELINE_STAGES: ReadonlyArray<{ key: PipelineStatus; label: string }> = [
  { key: "configuration", label: "Configuration" },
  { key: "ideation", label: "Ideation" },
  { key: "review", label: "Review" },
  { key: "generation", label: "Generation" },
  { key: "creative_qa", label: "Creative QA" },
  { key: "compliance_review", label: "Compliance" },
  { key: "copy", label: "Copy" },
  { key: "spec_validation", label: "Spec Validation" },
  { key: "variant_plan", label: "Variant Plan" },
  { key: "finalize_assets", label: "Finalize" },
  { key: "launch_handoff", label: "Launch" },
  { key: "monitor", label: "Monitor" },
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
  creative_qa: "Creative QA",
  compliance_review: "Compliance",
  copy: "Copy",
  spec_validation: "Spec Validation",
  variant_plan: "Variant Plan",
  finalize_assets: "Finalize",
  launch_handoff: "Launch",
  monitor: "Monitor",
  done: "Done",
  cancelled: "Cancelled",
};

export const PIPELINE_STATUS_BADGE: Record<PipelineStatus, string> = {
  configuration: "bg-muted text-muted-foreground",
  ideation: "bg-sky-100 text-sky-900 dark:bg-sky-950/40 dark:text-sky-200",
  review: "bg-amber-100 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200",
  generation: "bg-violet-100 text-violet-900 dark:bg-violet-950/40 dark:text-violet-200",
  creative_qa: "bg-teal-100 text-teal-900 dark:bg-teal-950/40 dark:text-teal-200",
  // compliance + launch are HARD gates — flag them in a warning palette.
  compliance_review: "bg-rose-100 text-rose-900 dark:bg-rose-950/40 dark:text-rose-200",
  copy: "bg-indigo-100 text-indigo-900 dark:bg-indigo-950/40 dark:text-indigo-200",
  spec_validation: "bg-cyan-100 text-cyan-900 dark:bg-cyan-950/40 dark:text-cyan-200",
  variant_plan: "bg-fuchsia-100 text-fuchsia-900 dark:bg-fuchsia-950/40 dark:text-fuchsia-200",
  finalize_assets: "bg-lime-100 text-lime-900 dark:bg-lime-950/40 dark:text-lime-200",
  launch_handoff: "bg-orange-100 text-orange-900 dark:bg-orange-950/40 dark:text-orange-200",
  monitor: "bg-blue-100 text-blue-900 dark:bg-blue-950/40 dark:text-blue-200",
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
