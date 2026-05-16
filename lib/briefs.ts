import { z } from "zod";

import type { Database } from "@/lib/supabase/types.gen";

/**
 * Brief lifecycle: zod schemas, status state machine, and shared types.
 *
 * The image-brief side of the marketing pipeline. Operators (or an AI helper)
 * create a draft, post it for approval, then approve / approve-with-changes
 * / reject. Every transition emits an `events` row and is enforced by both
 * the DB-level CHECK constraint and the in-memory state machine below.
 *
 * Schema invariants (from `db/migrations/0001_initial_schema.sql`):
 *  - `payload` must contain both `service` and `budget` (jsonb CHECK).
 *  - `brief_id_human` is unique and minted via `gen_brief_id_human(slug)`.
 *  - `status` defaults to `draft`; the `brief_status` enum is the source of truth.
 */

export const ServiceType = z.enum(["roofing", "remodeling"]);
export type ServiceTypeT = z.infer<typeof ServiceType>;

export const BriefStatus = z.enum([
  "draft",
  "posted",
  "approved",
  "approved_with_changes",
  "rejected",
]);
export type BriefStatusT = z.infer<typeof BriefStatus>;

/**
 * Optional targeting block. All fields nullable so an operator can post a
 * brief with just market + budget while AI / planning fills in the rest.
 */
export const TargetingSchema = z
  .object({
    radius_km: z.number().int().positive().max(500).optional(),
    zips: z.array(z.string().min(3).max(12)).max(200).optional(),
    age_min: z.number().int().min(13).max(90).optional(),
    age_max: z.number().int().min(13).max(90).optional(),
  })
  .refine((t) => t.age_min === undefined || t.age_max === undefined || t.age_min <= t.age_max, {
    message: "age_min must be ≤ age_max",
    path: ["age_max"],
  });

/**
 * Brief payload — what gets written into `briefs.payload` jsonb.
 * `service` and `budget` are required by the DB CHECK constraint; everything
 * else is shape-validated here and JSON-stored alongside.
 */
export const BriefPayload = z.object({
  service: ServiceType,
  budget: z.number().positive().max(100000),
  budget_daily: z.number().positive().max(10000).optional(),
  market: z.string().min(2).max(200),
  targeting: TargetingSchema.optional(),
  landing_page_url: z.string().url().max(2048).optional(),
  creative_plan: z
    .object({
      image_count: z.number().int().min(1).max(20).default(3),
    })
    .optional(),
  angles: z.array(z.string().min(1).max(500)).max(50).optional(),
  offer_text: z.string().max(2000).optional(),
  notes: z.string().max(5000).optional(),
});
export type BriefPayloadT = z.infer<typeof BriefPayload>;

/**
 * Input to `POST /api/briefs`. Operator picks a client and supplies the
 * payload; the server mints the human id and the row.
 */
export const CreateBriefInput = z.object({
  client_id: z.string().uuid(),
  payload: BriefPayload,
});
export type CreateBriefInputT = z.infer<typeof CreateBriefInput>;

/**
 * Input to `PATCH /api/briefs/:id`. Either:
 *  - mutate `payload` (only valid while status is `draft` or `posted` if the
 *    operator is iterating before a decision), and/or
 *  - request a `status` transition (validated against the state machine).
 *
 * Both fields optional; the route accepts any non-empty subset.
 */
export const UpdateBriefInput = z
  .object({
    payload: BriefPayload.optional(),
    status: BriefStatus.optional(),
  })
  .refine((v) => v.payload !== undefined || v.status !== undefined, {
    message: "at least one of `payload` or `status` is required",
  });
export type UpdateBriefInputT = z.infer<typeof UpdateBriefInput>;

/**
 * Approval decisions. `approved_with_changes` and `rejected` REQUIRE notes —
 * the operator must explain what's wrong / what to fix. Pure `approved` is
 * note-optional.
 */
export const Decision = z.enum(["approved", "approved_with_changes", "rejected"]);
export type DecisionT = z.infer<typeof Decision>;

export const DecisionInput = z
  .object({
    decision: Decision,
    notes: z.string().max(5000).optional(),
  })
  .refine(
    (d) => d.decision === "approved" || (typeof d.notes === "string" && d.notes.trim().length > 0),
    { message: "notes are required for approved_with_changes and rejected", path: ["notes"] },
  );
export type DecisionInputT = z.infer<typeof DecisionInput>;

/**
 * Status state machine. Terminal states (`approved`, `approved_with_changes`)
 * cannot transition further; rejected can be re-drafted. The approval-gate
 * routes only act on `posted -> {approved, approved_with_changes, rejected}`.
 */
export const allowedTransitions: Record<BriefStatusT, BriefStatusT[]> = {
  draft: ["posted"],
  posted: ["draft", "approved", "approved_with_changes", "rejected"],
  approved: [],
  approved_with_changes: [],
  rejected: ["draft"],
};

export function canTransition(from: BriefStatusT, to: BriefStatusT): boolean {
  if (from === to) return true; // no-op patches are allowed
  return allowedTransitions[from]?.includes(to) ?? false;
}

/**
 * Build the canonical event name for a status transition. Keeps the kinds
 * grep-able in the events table: `brief_<from>_to_<to>`.
 */
export function transitionEventKind(from: BriefStatusT, to: BriefStatusT): string {
  return `brief_${from}_to_${to}`;
}

export type Brief = Database["public"]["Tables"]["briefs"]["Row"];
export type BriefInsert = Database["public"]["Tables"]["briefs"]["Insert"];
export type BriefUpdate = Database["public"]["Tables"]["briefs"]["Update"];
export type EventRow = Database["public"]["Tables"]["events"]["Row"];

/**
 * Narrows the unsafe `Brief["payload"]` (`Json`) to the typed shape we know
 * passed `BriefPayload` validation at write time. Returns `null` if the row
 * is somehow malformed (e.g. older row, external write).
 */
export function readBriefPayload(brief: Pick<Brief, "payload">): BriefPayloadT | null {
  const parsed = BriefPayload.safeParse(brief.payload);
  return parsed.success ? parsed.data : null;
}
