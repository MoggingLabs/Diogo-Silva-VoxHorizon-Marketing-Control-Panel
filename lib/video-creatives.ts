import { z } from "zod";

import type { Database } from "@/lib/supabase/types.gen";

/**
 * Video creative lifecycle: zod schemas, status state machine, and shared types.
 *
 * Mirrors the shape of `lib/creatives.ts` (image side) and reuses the
 * existing Wave-3 patterns. A video creative is one full-pipeline output
 * for a video brief — the worker walks it through script → voiceover →
 * b-roll → composed → captioned before the operator can approve it.
 *
 * Schema invariants (from `db/migrations/0001_initial_schema.sql`):
 *  - `video_creatives.status` enum:
 *      draft | script_ready | voiceover_ready | broll_ready
 *           | composed | captioned | approved | rejected.
 *  - `video_iterations.kind` enum:
 *      generate_script | regenerate_voiceover | search_broll
 *      | swap_broll | rerender | recaption | comment | user_edit.
 *  - `video_iterations.author` enum: user | ekko.
 */

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const VideoCreativeStatus = z.enum([
  "draft",
  "script_ready",
  "voiceover_ready",
  "broll_ready",
  "composed",
  "captioned",
  "approved",
  "rejected",
]);
export type VideoCreativeStatusT = z.infer<typeof VideoCreativeStatus>;

export const VideoCreativeDecision = z.enum(["approve", "reject"]);
export type VideoCreativeDecisionT = z.infer<typeof VideoCreativeDecision>;

export const VideoIterationKind = z.enum([
  "generate_script",
  "regenerate_voiceover",
  "search_broll",
  "swap_broll",
  "rerender",
  "recaption",
  "comment",
  "user_edit",
]);
export type VideoIterationKindT = z.infer<typeof VideoIterationKind>;

export const VideoIterationAuthor = z.enum(["user", "ekko"]);
export type VideoIterationAuthorT = z.infer<typeof VideoIterationAuthor>;

// ---------------------------------------------------------------------------
// Decision API input
// ---------------------------------------------------------------------------

/**
 * Input to `POST /api/creatives/video/:id/decision`. Mirrors the image-side
 * shape — the iteration thread is the right place for free-form notes.
 */
export const VideoDecisionInput = z.object({
  decision: VideoCreativeDecision,
});
export type VideoDecisionInputT = z.infer<typeof VideoDecisionInput>;

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

/**
 * Decisions allowed for each origin status.
 *
 *  - `captioned` is the only state where both approve and reject are valid:
 *    that's when the full pipeline (script + voiceover + b-roll + compose +
 *    caption) has produced a shippable MP4.
 *  - Earlier stages may be rejected to short-circuit a bad run, but the
 *    operator cannot approve until captioning is done.
 *  - Terminal statuses (`approved`, `rejected`) accept no further decisions.
 */
export const allowedDecisions: Record<VideoCreativeStatusT, VideoCreativeDecisionT[]> = {
  draft: ["reject"],
  script_ready: ["reject"],
  voiceover_ready: ["reject"],
  broll_ready: ["reject"],
  composed: ["reject"],
  captioned: ["approve", "reject"],
  approved: [],
  rejected: [],
};

export function canDecide(from: VideoCreativeStatusT, decision: VideoCreativeDecisionT): boolean {
  return allowedDecisions[from]?.includes(decision) ?? false;
}

/**
 * Translate an operator decision into the resulting status.
 * Approve only fires from `captioned`, which is enforced by `canDecide`,
 * so the mapping is straightforward.
 */
export function decisionToStatus(
  decision: VideoCreativeDecisionT,
): Extract<VideoCreativeStatusT, "approved" | "rejected"> {
  return decision === "approve" ? "approved" : "rejected";
}

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

export type VideoCreative = Database["public"]["Tables"]["video_creatives"]["Row"];
export type VideoCreativeInsert = Database["public"]["Tables"]["video_creatives"]["Insert"];
export type VideoCreativeUpdate = Database["public"]["Tables"]["video_creatives"]["Update"];
export type VideoIteration = Database["public"]["Tables"]["video_iterations"]["Row"];

// ---------------------------------------------------------------------------
// B-roll clip payload
// ---------------------------------------------------------------------------

/**
 * Shape of one entry inside `video_creatives.broll_clips` (jsonb array).
 * Matches the worker's contract — see migration 0001 comments.
 *
 * `store_backend` is `local` for the dev default (LocalBrollStore on the
 * worker disk) or `supabase` once the SupabaseBrollStore migration ships.
 */
export const BrollClip = z.object({
  segment_idx: z.number().int().min(0),
  store_backend: z.enum(["local", "supabase"]),
  clip_id: z.string().min(1),
  in_s: z.number().min(0),
  out_s: z.number().min(0),
  source_url: z.string().min(1),
  // Optional metadata fields the worker may stamp for downstream UIs.
  confidence: z.number().optional(),
  theme: z.string().optional(),
  thumbnail_url: z.string().optional(),
});
export type BrollClipT = z.infer<typeof BrollClip>;

export const BrollClips = z.array(BrollClip);

/**
 * Parse the loose jsonb `broll_clips` column into a typed array. Returns
 * an empty array on shape errors so the UI can degrade gracefully.
 */
export function readBrollClips(value: VideoCreative["broll_clips"]): BrollClipT[] {
  if (!value) return [];
  const parsed = BrollClips.safeParse(value);
  return parsed.success ? parsed.data : [];
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

/**
 * Storage bucket holding final video artifacts (MP4 + intermediate audio).
 * Same bucket as the image side per migration 0003 — the video path layout
 * keys off `brief_id/version/*` to avoid collisions.
 */
export const CREATIVES_BUCKET = "creatives";

/** Default TTL for signed URLs we hand to the browser (1 hour). */
export const DEFAULT_SIGNED_URL_TTL_S = 3600;

type SignedUrlClient = {
  storage: {
    from: (bucket: string) => {
      createSignedUrl: (
        path: string,
        expiresIn: number,
      ) => Promise<{ data: { signedUrl: string } | null; error: { message: string } | null }>;
    };
  };
};

/**
 * Resolve a signed URL for a video artifact. Returns `null` when the path
 * is missing or the storage call fails — callers should render a fallback
 * (poster / placeholder) in that case rather than throwing.
 *
 * Server-side only: hits `storage.from(...).createSignedUrl(...)` which
 * requires a server or admin Supabase client.
 */
export async function getSignedUrl(
  client: SignedUrlClient,
  filePath: string | null,
  ttlSeconds: number = DEFAULT_SIGNED_URL_TTL_S,
): Promise<string | null> {
  if (!filePath) return null;
  const { data, error } = await client.storage
    .from(CREATIVES_BUCKET)
    .createSignedUrl(filePath, ttlSeconds);
  if (error || !data?.signedUrl) {
    if (error) {
      console.warn(`[video-creatives.getSignedUrl] ${filePath}: ${error.message}`);
    }
    return null;
  }
  return data.signedUrl;
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

/**
 * Operator-facing labels and pill classes for each video status.
 * Light-mode-only palette, escalating from neutral → indigo (pipeline in
 * progress) → emerald (captioned, awaitable approval) → terminal colours.
 */
export const STATUS_LABEL: Record<VideoCreativeStatusT, string> = {
  draft: "Draft",
  script_ready: "Script ready",
  voiceover_ready: "Voiceover ready",
  broll_ready: "B-roll ready",
  composed: "Composed",
  captioned: "Captioned",
  approved: "Approved",
  rejected: "Rejected",
};

export const STATUS_PILL: Record<VideoCreativeStatusT, string> = {
  draft: "bg-zinc-100 text-zinc-700",
  script_ready: "bg-indigo-50 text-indigo-700",
  voiceover_ready: "bg-indigo-100 text-indigo-800",
  broll_ready: "bg-indigo-200 text-indigo-900",
  composed: "bg-violet-100 text-violet-800",
  captioned: "bg-emerald-100 text-emerald-800",
  approved: "bg-green-200 text-green-900",
  rejected: "bg-rose-100 text-rose-800",
};

/**
 * Stage progression order used by the side panel to render a small
 * step-tracker. Approved / rejected are terminal and don't appear in the
 * tracker.
 */
export const STAGE_ORDER: VideoCreativeStatusT[] = [
  "draft",
  "script_ready",
  "voiceover_ready",
  "broll_ready",
  "composed",
  "captioned",
];

/** Pretty label for one of the eight `video_iteration_kind` values. */
export const ITERATION_KIND_LABEL: Record<VideoIterationKindT, string> = {
  generate_script: "Generated script",
  regenerate_voiceover: "Regenerated voiceover",
  search_broll: "Searched b-roll",
  swap_broll: "Swapped b-roll",
  rerender: "Re-rendered",
  recaption: "Re-captioned",
  comment: "Comment",
  user_edit: "Edit",
};

export const ITERATION_AUTHOR_LABEL: Record<VideoIterationAuthorT, string> = {
  user: "Operator",
  ekko: "Ekko",
};
