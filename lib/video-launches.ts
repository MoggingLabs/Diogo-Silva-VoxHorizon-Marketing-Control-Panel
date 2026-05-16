import { z } from "zod";

import type { Database, Json } from "@/lib/supabase/types.gen";

/**
 * Video launch package: zod schemas + status state machine.
 *
 * Mirrors ``lib/launches.ts`` for the video side. Two verticals
 * deliberately keep their own modules so each can evolve column shapes
 * independently — see ``db/SCHEMA.md`` for the rationale.
 */

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** POST /api/launches/video body. */
export const VideoLaunchInput = z.object({
  brief_id: z.string().uuid("brief_id must be a uuid"),
});
export type VideoLaunchInputT = z.infer<typeof VideoLaunchInput>;

export const VideoLaunchDecision = z.enum(["approved", "approved_with_changes", "rejected"]);
export type VideoLaunchDecisionT = z.infer<typeof VideoLaunchDecision>;

export const VideoLaunchDecisionInput = z
  .object({
    decision: VideoLaunchDecision,
    notes: z.string().max(5000).optional(),
  })
  .refine(
    (d) => d.decision === "approved" || (typeof d.notes === "string" && d.notes.trim().length > 0),
    { message: "notes are required for approved_with_changes and rejected", path: ["notes"] },
  );
export type VideoLaunchDecisionInputT = z.infer<typeof VideoLaunchDecisionInput>;

// ---------------------------------------------------------------------------
// Status state machine
// ---------------------------------------------------------------------------

export const VideoLaunchStatus = z.enum([
  "validating",
  "posted",
  "approved",
  "approved_with_changes",
  "rejected",
  "failed",
]);
export type VideoLaunchStatusT = z.infer<typeof VideoLaunchStatus>;

export const allowedVideoTransitions: Record<VideoLaunchStatusT, VideoLaunchStatusT[]> = {
  validating: ["posted", "failed"],
  posted: ["approved", "approved_with_changes", "rejected"],
  approved: [],
  approved_with_changes: [],
  rejected: [],
  failed: [],
};

export function canTransitionVideoLaunch(
  from: VideoLaunchStatusT,
  to: VideoLaunchStatusT,
): boolean {
  if (from === to) return true;
  return allowedVideoTransitions[from]?.includes(to) ?? false;
}

// ---------------------------------------------------------------------------
// Issue + payload shape
// ---------------------------------------------------------------------------

export const VideoLaunchIssueSeverity = z.enum(["error", "warning"]);
export type VideoLaunchIssueSeverityT = z.infer<typeof VideoLaunchIssueSeverity>;

export const VideoLaunchIssue = z.object({
  severity: VideoLaunchIssueSeverity,
  message: z.string(),
  ref_table: z.string().optional(),
  ref_id: z.string().optional(),
});
export type VideoLaunchIssueT = z.infer<typeof VideoLaunchIssue>;

export const VideoLaunchPayload = z.object({
  brief_id_human: z.string(),
  client: z
    .object({
      id: z.string(),
      slug: z.string(),
      name: z.string(),
    })
    .nullable(),
  video_creative_ids: z.array(z.string().uuid()),
  copy_variant_ids: z.array(z.string().uuid()),
  issues: z.array(VideoLaunchIssue).default([]),
  validation: z.object({
    ok: z.boolean(),
    via: z.enum(["preflight", "scripts_runner"]),
    raw_stdout: z.string().optional(),
    raw_stderr: z.string().optional(),
  }),
});
export type VideoLaunchPayloadT = z.infer<typeof VideoLaunchPayload>;

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------

export type VideoLaunchPackage = Database["public"]["Tables"]["video_launch_packages"]["Row"];
export type VideoLaunchPackageInsert =
  Database["public"]["Tables"]["video_launch_packages"]["Insert"];
export type VideoLaunchPackageUpdate =
  Database["public"]["Tables"]["video_launch_packages"]["Update"];

export function readVideoLaunchPayload(
  row: Pick<VideoLaunchPackage, "payload">,
): VideoLaunchPayloadT | null {
  const parsed = VideoLaunchPayload.safeParse(row.payload);
  return parsed.success ? parsed.data : null;
}

export function videoPayloadToJson(p: VideoLaunchPayloadT): Json {
  return JSON.parse(JSON.stringify(p)) as Json;
}
