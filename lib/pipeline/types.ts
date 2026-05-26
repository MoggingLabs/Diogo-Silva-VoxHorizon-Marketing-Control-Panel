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

import { HAPPY_PATH_STAGES } from "@/lib/pipeline/stages";
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
  // Soft-archive tombstone (#609). Null = active; set = archived (hidden from
  // the default list, restorable).
  deleted_at: string | null;
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
 *
 * DERIVED from the stage registry (`./stages`) -- the single source of truth
 * (E2.1). `HAPPY_PATH_STAGES` is every registry entry except the `cancelled`
 * escape, already in DAG order. The `key` is cast to `PipelineStatus`: if a
 * stage key in the registry ever stops matching the DB `pipeline_status_enum`,
 * the exhaustive label/badge maps below stop type checking -- the drift signal.
 */
export const PIPELINE_STAGES: ReadonlyArray<{ key: PipelineStatus; label: string }> =
  HAPPY_PATH_STAGES.map((s) => ({ key: s.key as PipelineStatus, label: s.label }));

/**
 * Human-readable stage labels. M8 routes every status PILL through the
 * canonical `components/ui/StatusBadge` so the operator reads the same colour
 * for the same meaning across every surface. This map stays for the places
 * that need just the stage NAME as text (PhaseStepper child chips, narration
 * meta caption) without rendering a full badge.
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
