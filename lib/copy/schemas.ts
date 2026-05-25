import { z } from "zod";

import type { Database } from "@/lib/supabase/types.gen";

/**
 * Zod schemas + DB passthroughs for the in-pipeline copy stage (#359, P4.4).
 *
 * The CopyComposer authors / edits / approves ≥3 variants per creative; the
 * `copy_variants` table (rebuilt in migration 0020) is wired here for the first
 * time. These schemas back `POST /api/pipelines/[id]/copy` (upsert a variant)
 * and `POST /api/pipelines/[id]/copy/decision` (approve / reject).
 */

export const CopyPlatformEnum = z.enum(["meta", "google", "tiktok"]);
export type CopyPlatformT = z.infer<typeof CopyPlatformEnum>;

export const CopyPlacementEnum = z.enum([
  "feed",
  "stories",
  "reels",
  "marketplace",
  "search",
  "display",
  "pmax",
]);

export const CopyVariantStatusEnum = z.enum([
  "draft",
  "validated",
  "approved",
  "rejected",
  "retired",
]);
export type CopyVariantStatusT = z.infer<typeof CopyVariantStatusEnum>;

/**
 * Body for `POST /api/pipelines/:id/copy` — upsert one copy variant. The unique
 * key is (creative_id, platform, variant_index) so a re-POST with the same
 * triple edits in place (matching the `copy_variants_creative_platform_variant`
 * index). Editing copy re-arms compliance, so the route flips an `approved`
 * variant back to `draft` on edit (caller decides; the route enforces).
 */
export const UpsertCopyInput = z.object({
  /** Omit to create; pass to edit a specific row. */
  id: z.string().uuid().optional(),
  creative_id: z.string().uuid(),
  platform: CopyPlatformEnum.default("meta"),
  placement: CopyPlacementEnum.optional(),
  variant_index: z.number().int().min(1).max(50),
  headline: z.string().max(2000).optional(),
  /** Meta "primary text". */
  body: z.string().max(20000).optional(),
  description: z.string().max(2000).optional(),
  cta: z.string().max(200).optional(),
  pattern: z.string().max(200).optional(),
  humanized: z.boolean().optional(),
});
export type UpsertCopyInputT = z.infer<typeof UpsertCopyInput>;

/**
 * Body for `POST /api/pipelines/:id/copy/decision` — approve or reject a single
 * variant. Reject requires notes; approve is note-optional.
 */
export const CopyDecisionInput = z
  .object({
    id: z.string().uuid(),
    decision: z.enum(["approved", "rejected"]),
    notes: z.string().max(5000).optional(),
  })
  .refine(
    (d) => d.decision === "approved" || (typeof d.notes === "string" && d.notes.trim().length > 0),
    { message: "notes are required to reject a copy variant", path: ["notes"] },
  );
export type CopyDecisionInputT = z.infer<typeof CopyDecisionInput>;

/**
 * Standalone copy CRUD (Makeover M3 / E3.3, #592).
 *
 * The pipeline copy stage (`POST /api/pipelines/:id/copy`) manages variants
 * while a run is in the `copy` stage. E3.3 adds an out-of-pipeline editor so the
 * operator can manage `copy_variants` / `video_copy_variants` directly from a
 * brief/creative, without a live pipeline. Same dual-table parity + the same
 * "editing re-arms compliance" rule (an edit resets the variant to `draft`).
 */

export const CopyFormat = z.enum(["image", "video"]);
export type CopyFormatT = z.infer<typeof CopyFormat>;

/** The copy content fields shared by both tables. */
const copyContentShape = {
  headline: z.string().max(2000).optional(),
  /** Meta "primary text". */
  body: z.string().max(20000).optional(),
  description: z.string().max(2000).optional(),
  cta: z.string().max(200).optional(),
  pattern: z.string().max(200).optional(),
  humanized: z.boolean().optional(),
} as const;

/**
 * Body for `POST /api/copy` — create one standalone variant. `format` selects
 * the destination table; the row is keyed by (creative_id, platform,
 * variant_index) like the pipeline path, so a collision returns a 409.
 */
export const CreateStandaloneCopyInput = z.object({
  format: CopyFormat,
  creative_id: z.string().uuid(),
  platform: CopyPlatformEnum.default("meta"),
  placement: CopyPlacementEnum.optional(),
  variant_index: z.number().int().min(1).max(50),
  ...copyContentShape,
});
export type CreateStandaloneCopyInputT = z.infer<typeof CreateStandaloneCopyInput>;

/**
 * Body for `PATCH /api/copy/:id` — edit one standalone variant. `format`
 * selects the table. Every content field is optional; placement + variant_index
 * may also be re-targeted. Editing re-arms compliance, so the route resets the
 * row to `draft` regardless of what changed.
 */
export const UpdateStandaloneCopyInput = z.object({
  format: CopyFormat,
  platform: CopyPlatformEnum.optional(),
  placement: CopyPlacementEnum.optional(),
  variant_index: z.number().int().min(1).max(50).optional(),
  ...copyContentShape,
});
export type UpdateStandaloneCopyInputT = z.infer<typeof UpdateStandaloneCopyInput>;

export type CopyVariant = Database["public"]["Tables"]["copy_variants"]["Row"];
export type CopyVariantInsert = Database["public"]["Tables"]["copy_variants"]["Insert"];
export type CopyVariantUpdate = Database["public"]["Tables"]["copy_variants"]["Update"];

// Video parity tables (migration 0031). A video creative's copy variant lives in
// `video_copy_variants`; the copy/decision route writes the format-appropriate
// subset (status + updated_at) since it lacks the image-only approved_by/_at cols.
export type VideoCopyVariant = Database["public"]["Tables"]["video_copy_variants"]["Row"];
export type VideoCopyVariantInsert = Database["public"]["Tables"]["video_copy_variants"]["Insert"];
export type VideoCopyVariantUpdate = Database["public"]["Tables"]["video_copy_variants"]["Update"];

/** The table name for a given copy format. */
export function copyTableFor(format: CopyFormatT): "copy_variants" | "video_copy_variants" {
  return format === "video" ? "video_copy_variants" : "copy_variants";
}
