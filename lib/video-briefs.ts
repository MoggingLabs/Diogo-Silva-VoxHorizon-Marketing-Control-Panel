import { z } from "zod";

import type { Database } from "@/lib/supabase/types.gen";

/**
 * Video brief domain: zod schemas, status state machine, and types.
 *
 * Mirrors `lib/briefs.ts` on the image side. The two verticals intentionally
 * keep their own schema modules so each can evolve column shapes
 * independently — see `db/SCHEMA.md` for the rationale.
 */

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const VideoBriefStatus = z.enum([
  "draft",
  "posted",
  "approved",
  "approved_with_changes",
  "rejected",
]);
export type VideoBriefStatusT = z.infer<typeof VideoBriefStatus>;

export const Ratio = z.enum(["1x1", "9x16", "16x9"]);
export type RatioT = z.infer<typeof Ratio>;

export const HookStyle = z.enum(["curiosity", "pattern_interrupt", "data_shock", "question"]);
export type HookStyleT = z.infer<typeof HookStyle>;

export const CaptionsStyle = z.enum(["bold_yellow", "minimal_white", "brand"]);
export type CaptionsStyleT = z.infer<typeof CaptionsStyle>;

export const BrollSelectionMode = z.enum(["auto", "review_each", "review_low_confidence"]);
export type BrollSelectionModeT = z.infer<typeof BrollSelectionMode>;

// ---------------------------------------------------------------------------
// Script outline
// ---------------------------------------------------------------------------

export const ScriptSegment = z.object({
  topic: z.string().min(2, "topic is required"),
  duration_s: z.number().positive("duration must be > 0"),
  broll_theme: z.string().optional(),
});
export type ScriptSegmentT = z.infer<typeof ScriptSegment>;

export const ScriptOutline = z.object({
  hook: z.string().min(5, "hook is required (min 5 chars)"),
  segments: z.array(ScriptSegment).min(1, "at least one segment"),
});
export type ScriptOutlineT = z.infer<typeof ScriptOutline>;

// ---------------------------------------------------------------------------
// Input schema for create + edit
// ---------------------------------------------------------------------------

const sumOfSegments = (segments: ScriptSegmentT[]) =>
  segments.reduce((s, x) => s + x.duration_s, 0);

const durationMatches = (segments: ScriptSegmentT[], target: number): boolean =>
  Math.abs(sumOfSegments(segments) - target) < 1;

export const VideoBriefInput = z
  .object({
    client_id: z.uuid("client_id must be a uuid"),
    script_outline: ScriptOutline,
    target_duration_s: z.number().int().positive().max(180, "max 180 seconds"),
    voice_id: z.string().min(2, "voice_id is required"),
    music_track: z.string().optional(),
    hook_style: HookStyle.optional(),
    dimensions: Ratio.default("9x16"),
    captions_style: CaptionsStyle.optional(),
    broll_selection_mode: BrollSelectionMode.default("review_each"),
    notes: z.string().optional(),
    payload: z.record(z.string(), z.unknown()).optional(),
  })
  .refine((b) => durationMatches(b.script_outline.segments, b.target_duration_s), {
    message: "sum of segment durations must equal target_duration_s (±1s)",
    path: ["target_duration_s"],
  });
/** Pre-parse shape: defaulted fields are still optional. Used by forms. */
export type VideoBriefInputT = z.input<typeof VideoBriefInput>;
/** Post-parse shape: defaults applied. Used by API handlers + insert rows. */
export type VideoBriefParsedT = z.output<typeof VideoBriefInput>;

/**
 * Partial-edit schema for PATCH. Every field is optional, but if either
 * `target_duration_s` or `script_outline.segments` is provided we require
 * both so we can re-validate the duration check.
 */
export const VideoBriefPatchInput = z
  .object({
    script_outline: ScriptOutline.optional(),
    target_duration_s: z.number().int().positive().max(180).optional(),
    voice_id: z.string().min(2).optional(),
    music_track: z.string().optional(),
    hook_style: HookStyle.optional(),
    dimensions: Ratio.optional(),
    captions_style: CaptionsStyle.optional(),
    broll_selection_mode: BrollSelectionMode.optional(),
    notes: z.string().optional(),
    payload: z.record(z.string(), z.unknown()).optional(),
    status: VideoBriefStatus.optional(),
  })
  .refine(
    (b) => {
      // If both are present and outline includes segments, re-check.
      if (b.script_outline && b.target_duration_s) {
        return durationMatches(b.script_outline.segments, b.target_duration_s);
      }
      return true;
    },
    {
      message: "sum of segment durations must equal target_duration_s (±1s)",
      path: ["target_duration_s"],
    },
  );
export type VideoBriefPatchInputT = z.infer<typeof VideoBriefPatchInput>;

// ---------------------------------------------------------------------------
// Approval decision
// ---------------------------------------------------------------------------

export const Decision = z.enum(["approved", "approved_with_changes", "rejected"]);
export type DecisionT = z.infer<typeof Decision>;

export const DecisionInput = z
  .object({
    decision: Decision,
    notes: z.string().optional(),
  })
  .refine((d) => d.decision === "approved" || Boolean(d.notes && d.notes.length > 0), {
    message: "notes required for approved_with_changes and rejected",
    path: ["notes"],
  });
export type DecisionInputT = z.infer<typeof DecisionInput>;

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

export const allowedTransitions: Record<VideoBriefStatusT, VideoBriefStatusT[]> = {
  draft: ["posted"],
  posted: ["draft", "approved", "approved_with_changes", "rejected"],
  approved: [],
  approved_with_changes: [],
  rejected: ["draft"],
};

export function canTransition(from: VideoBriefStatusT, to: VideoBriefStatusT): boolean {
  return allowedTransitions[from].includes(to);
}

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------

export type VideoBrief = Database["public"]["Tables"]["video_briefs"]["Row"];
export type VideoBriefInsertRow = Database["public"]["Tables"]["video_briefs"]["Insert"];
export type VideoBriefUpdateRow = Database["public"]["Tables"]["video_briefs"]["Update"];

/** Decision values that should be considered "approved-ish" downstream. */
export const APPROVING_DECISIONS: DecisionT[] = ["approved", "approved_with_changes"];

/** Sum of segment durations — exposed for live form previews. */
export function totalSegmentDuration(segments: ScriptSegmentT[]): number {
  return sumOfSegments(segments);
}
