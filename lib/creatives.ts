import { z } from "zod";

import type { Database } from "@/lib/supabase/types.gen";

/**
 * Image creative lifecycle: zod schemas, status state machine, and shared types.
 *
 * Mirrors the shape of `lib/briefs.ts`. A creative is a single image variant
 * produced by the worker (Agent CB) for an approved brief. The operator
 * reviews the variants grid for a brief, drills into one via the side panel
 * (iteration thread + decision buttons), and ends up approving or rejecting.
 *
 * Schema invariants (from `db/migrations/0001_initial_schema.sql`):
 *  - `creatives.status` enum: `draft | approved | rejected | live | killed`.
 *  - `creatives.type` enum: `image | video`. This module only covers `image`.
 *  - `creative_iterations.kind` enum: `generate | regenerate | annotate |
 *    comment | user_edit`.
 *  - `creative_iterations.author` enum: `user | ekko`.
 */

export const CreativeStatus = z.enum(["draft", "approved", "rejected", "live", "killed"]);
export type CreativeStatusT = z.infer<typeof CreativeStatus>;

export const CreativeDecision = z.enum(["approve", "reject"]);
export type CreativeDecisionT = z.infer<typeof CreativeDecision>;

export const IterationKind = z.enum(["generate", "regenerate", "annotate", "comment", "user_edit"]);
export type IterationKindT = z.infer<typeof IterationKind>;

export const IterationAuthor = z.enum(["user", "ekko"]);
export type IterationAuthorT = z.infer<typeof IterationAuthor>;

export const Ratio = z.enum(["1x1", "9x16", "16x9"]);
export type RatioT = z.infer<typeof Ratio>;

/**
 * Input to `POST /api/creatives/:id/decision`. The body shape is intentionally
 * tiny — no notes are required at the creative level (annotations and
 * comments belong in the iteration thread).
 */
export const DecisionInput = z.object({
  decision: CreativeDecision,
});
export type DecisionInputT = z.infer<typeof DecisionInput>;

/**
 * Editable creative metadata for `PATCH /api/creatives/:id` (M4 / #594).
 *
 * Only the operator-safe descriptive fields are editable here — never
 * `status` (which flows through the decision route), never the worker-owned
 * render paths / verification flags, never the FK lineage (`brief_id`,
 * `pipeline_id`). Every key is optional; at least one must be present (the
 * route rejects an empty patch with 400 "nothing to update").
 *
 * `concept` / `offer_text` / `asset_name` accept an empty string or null to
 * clear the field; `ratio` is constrained to the `ratio` enum.
 */
export const UpdateCreativeInput = z
  .object({
    concept: z.string().max(2000).nullable(),
    offer_text: z.string().max(2000).nullable(),
    asset_name: z.string().max(500).nullable(),
    ratio: Ratio.nullable(),
  })
  .partial();
export type UpdateCreativeInputT = z.infer<typeof UpdateCreativeInput>;

/**
 * Status state machine. `draft` is the only origin state that accepts the
 * operator's approve/reject decision. Once decided, the creative is
 * terminal as far as the review UI is concerned — `live` / `killed` are
 * driven by launch + perf jobs downstream and not reachable from this UI.
 */
export const allowedDecisions: Record<CreativeStatusT, CreativeDecisionT[]> = {
  draft: ["approve", "reject"],
  approved: [],
  rejected: [],
  live: [],
  killed: [],
};

export function canDecide(from: CreativeStatusT, decision: CreativeDecisionT): boolean {
  return allowedDecisions[from]?.includes(decision) ?? false;
}

/**
 * Translates a decision into the resulting status enum value. Kept as a
 * standalone function so the API route and any future side-effect handlers
 * agree on the mapping.
 */
export function decisionToStatus(decision: CreativeDecisionT): CreativeStatusT {
  return decision === "approve" ? "approved" : "rejected";
}

export type Creative = Database["public"]["Tables"]["creatives"]["Row"];
export type CreativeInsert = Database["public"]["Tables"]["creatives"]["Insert"];
export type CreativeUpdate = Database["public"]["Tables"]["creatives"]["Update"];
export type CreativeIteration = Database["public"]["Tables"]["creative_iterations"]["Row"];

/**
 * Storage bucket holding final creative renders. Defined in
 * `db/migrations/0003_storage_buckets.sql`.
 */
export const CREATIVES_BUCKET = "creatives";

/**
 * Default TTL for signed URLs we hand to the browser. One hour is a
 * comfortable read window for the review UI without forcing a refresh
 * after every page reload.
 */
export const DEFAULT_SIGNED_URL_TTL_S = 3600;

/**
 * Resolve a signed URL for a creative's image. Returns `null` when the
 * path is missing or the storage call fails — callers should render a
 * placeholder tile in that case rather than throwing.
 *
 * Server-side only: this hits `storage.from(...).createSignedUrl(...)`
 * which requires a Supabase client (admin or server). Pass the client
 * in so this helper stays free of cookie/admin coupling.
 */
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
      console.warn(`[creatives.getSignedUrl] ${filePath}: ${error.message}`);
    }
    return null;
  }
  return data.signedUrl;
}

/**
 * Operator-facing labels and pill classes for each status. Light-mode-only
 * neutral palette; matches the Wave 2 Kanban look.
 */
export const STATUS_LABEL: Record<CreativeStatusT, string> = {
  draft: "Draft",
  approved: "Approved",
  rejected: "Rejected",
  live: "Live",
  killed: "Killed",
};

export const STATUS_PILL: Record<CreativeStatusT, string> = {
  draft: "bg-zinc-100 text-zinc-700",
  approved: "bg-emerald-100 text-emerald-800",
  rejected: "bg-rose-100 text-rose-800",
  live: "bg-indigo-100 text-indigo-800",
  killed: "bg-zinc-200 text-zinc-600",
};
