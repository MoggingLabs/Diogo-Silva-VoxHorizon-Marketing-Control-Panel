import { z } from "zod";

import type { Database } from "@/lib/supabase/types.gen";

/**
 * Pipeline / Ad Factory: zod schemas + shared types.
 *
 * The Pipeline feature is a guided multi-step ad-creation flow. A single
 * `pipelines` row tracks one run through the state machine:
 *
 *   configuration → ideation → review → generation → done
 *                                                  ↘ cancelled
 *
 * Image and video briefs are referenced by FK; the pipeline does not own
 * brief content. Per-run state lives in the jsonb columns (`config_draft`,
 * `picks`, `cost_estimate`, `cost_actual`, `approval`); the shapes evolve
 * as later milestones (PF-B, PF-C…) wire the UI in.
 *
 * Schema invariants (from `db/migrations/0006_pipelines.sql`):
 *  - `format_choice` is set at creation and never changes.
 *  - `status` starts at `configuration` and only moves forward via
 *    `pipeline_events(kind='stage_advanced')`.
 *  - jsonb defaults are `{}`; null is reserved for "not yet computed".
 */

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

/** Source of truth: `pipeline_format_enum` in the DB. */
export const PipelineFormat = z.enum(["image", "video", "both"]);
export type PipelineFormatT = z.infer<typeof PipelineFormat>;

/** Source of truth: `pipeline_status_enum` in the DB. */
export const PipelineStatus = z.enum([
  "configuration",
  "ideation",
  "review",
  "generation",
  "done",
  "cancelled",
]);
export type PipelineStatusT = z.infer<typeof PipelineStatus>;

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/**
 * Input to `POST /api/pipelines`. The format choice is required (drives all
 * downstream UI and which brief tables are referenced); `client_id` is
 * optional at creation time because the operator may pick a client later in
 * the configuration stage.
 */
export const CreatePipelineInput = z.object({
  format_choice: PipelineFormat,
  client_id: z.string().uuid().optional(),
});
export type CreatePipelineInputT = z.infer<typeof CreatePipelineInput>;

/**
 * Cursor for `GET /api/pipelines?cursor=<iso>`. We paginate on
 * `created_at desc` (newest first), so the cursor is the `created_at` of the
 * last item from the previous page; the next page is `created_at < cursor`.
 */
export const ListPipelinesQuery = z.object({
  status: PipelineStatus.optional(),
  client_id: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().datetime({ offset: true }).optional(),
});
export type ListPipelinesQueryT = z.infer<typeof ListPipelinesQuery>;

/**
 * Review-stage approval decisions. Mirrors `lib/briefs.ts`'s shape so the
 * shared `<ApprovalGate />` primitive keeps working: pure `approved` is
 * note-optional, while `approved_with_changes` and `rejected` require notes.
 *
 * `approved` / `approved_with_changes` both kick the pipeline forward to
 * `generation`; `rejected` moves it to `cancelled` (terminal in v1).
 */
export const ReviewDecision = z.enum(["approved", "approved_with_changes", "rejected"]);
export type ReviewDecisionT = z.infer<typeof ReviewDecision>;

export const ReviewDecisionInput = z
  .object({
    decision: ReviewDecision,
    notes: z.string().max(5000).optional(),
  })
  .refine(
    (d) => d.decision === "approved" || (typeof d.notes === "string" && d.notes.trim().length > 0),
    { message: "notes are required for approved_with_changes and rejected", path: ["notes"] },
  );
export type ReviewDecisionInputT = z.infer<typeof ReviewDecisionInput>;

// ---------------------------------------------------------------------------
// DB shape passthroughs
// ---------------------------------------------------------------------------

export type Pipeline = Database["public"]["Tables"]["pipelines"]["Row"];
export type PipelineInsert = Database["public"]["Tables"]["pipelines"]["Insert"];
export type PipelineUpdate = Database["public"]["Tables"]["pipelines"]["Update"];

export type PipelineEvent = Database["public"]["Tables"]["pipeline_events"]["Row"];
export type PipelineEventInsert = Database["public"]["Tables"]["pipeline_events"]["Insert"];
