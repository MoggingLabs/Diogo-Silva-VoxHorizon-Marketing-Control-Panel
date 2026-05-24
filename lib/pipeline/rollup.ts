/**
 * The per-creative gate rollup predicate — ONE source of truth (M2 / E2.3).
 *
 * Before this module the "is this per-creative stage cleared?" predicate existed
 * four times and had drifted:
 *   - the SQL `pipeline_rollup_cleared()` (db/migrations/0018, fixed in 0039),
 *   - the advance route's `computeRollup` (re-derived in TS),
 *   - `lib/review/grid.ts`'s `CLEARED_STATES` / `rollupCleared`,
 *   - the worker's Python `_stage_cleared`.
 * Three of them did NOT drop killed creatives from the scope; the grid did. A
 * killed creative must NOT hold a gate, so the grid behaviour is the intended
 * one — and it is now encoded ONCE here and mirrored by the SQL (0039).
 *
 * The canonical AUTHORITY is the SQL function `pipeline_rollup_cleared(pipeline,
 * stage)` (migration 0039): the live advance + launch paths enforce the gate
 * through the DB. This module is the TS mirror the route + the UI grid both read
 * so they agree with the DB by construction; a parity contract test
 * (`lib/pipeline/rollup.parity.test.ts`) reads migration 0039 and fails CI if
 * this set or the killed-exclusion rule drifts from the SQL.
 *
 * Pure — no IO. Data in / data out.
 */
import type { Database } from "@/lib/supabase/types.gen";

/** A per-(creative, stage) gate verdict, mirroring `stage_state_enum` (0017). */
export type StageState = Database["public"]["Enums"]["stage_state_enum"];

/** A creative lifecycle status, mirroring `image_creative_status` (0001). */
export type CreativeStatus = Database["public"]["Enums"]["image_creative_status"];

/**
 * The terminal-good verdicts that clear a per-creative gate. MUST equal the
 * `status not in (...)` exclusion set in the SQL `pipeline_rollup_cleared`
 * (migration 0039) — enforced by the parity contract test.
 */
export const CLEARED_STAGE_STATES: ReadonlySet<StageState> = new Set<StageState>([
  "passed",
  "overridden",
  "skipped",
]);

/** True when a single verdict counts as cleared (matches the SQL predicate). */
export function isStageStateCleared(status: StageState): boolean {
  return CLEARED_STAGE_STATES.has(status);
}

/**
 * Whether a creative is IN SCOPE for a stage's rollup. A killed (or soft-deleted)
 * creative drops out of the scope so it can never hold a gate — the killed-creative
 * fix that aligns every derivation with the grid + the SQL (0039). Only image
 * creatives can be `killed` (video_creative_status has no such value), so a video
 * creative is in scope unless soft-deleted.
 */
export function isCreativeInScope(creative: {
  status?: CreativeStatus | string | null;
  deleted_at?: string | null;
}): boolean {
  if (creative.deleted_at) return false;
  return creative.status !== "killed";
}

/**
 * The rollup verdict over a set of in-scope per-creative verdicts. Mirrors the
 * SQL `pipeline_rollup_cleared`: cleared iff there is ≥1 verdict AND every one of
 * them is terminal-good. The caller is responsible for passing ONLY the in-scope
 * verdicts (see {@link isCreativeInScope}).
 *
 * Returns `{ cleared, total, blocking }` so a caller can name what still holds
 * the gate without recomputing.
 */
export function rollupCleared(statuses: ReadonlyArray<StageState>): {
  cleared: boolean;
  total: number;
  blocking: number;
} {
  const total = statuses.length;
  const blocking = statuses.filter((s) => !isStageStateCleared(s)).length;
  return { cleared: total > 0 && blocking === 0, total, blocking };
}

// ---------------------------------------------------------------------------
// The `copy` gate (E2.5) — its own single-source predicate, NOT the rollup.
// ---------------------------------------------------------------------------
//
// `copy` is the one per-creative stage whose gate is NOT the creative_stage_state
// rollup. The operator copy tool only ever rolls creative_stage_state(copy) to
// `in_progress` (it never clears a gate), so gating `copy` on the rollup would
// STALL the stage permanently. The real gate is "≥N approved copy variants per
// in-scope creative" — the manager approves them at the copy stage. That
// predicate ALSO existed in several places (the advance route, the grid launch
// preconditions, the StageCopy UI, the worker launch re-check); it is unified
// here so they cannot drift.

/** Minimum approved copy variants required per in-scope creative before the copy
 * gate opens (and a launch precondition). Mirrored by the worker MIN_APPROVED_COPY. */
export const MIN_APPROVED_COPY = 3;

/**
 * Whether the `copy` gate is cleared: every in-scope creative has ≥
 * {@link MIN_APPROVED_COPY} approved copy variants (and ≥1 in-scope creative
 * exists). The caller passes the in-scope creative ids + a count of approved
 * variants per creative id. Returns `{ cleared, total, short }` so a 422 can name
 * how many creatives are short.
 */
export function copyGateCleared(
  inScopeCreativeIds: ReadonlyArray<string>,
  approvedByCreative: ReadonlyMap<string, number>,
): { cleared: boolean; total: number; short: number } {
  const total = inScopeCreativeIds.length;
  const short = inScopeCreativeIds.filter(
    (id) => (approvedByCreative.get(id) ?? 0) < MIN_APPROVED_COPY,
  ).length;
  return { cleared: total > 0 && short === 0, total, short };
}
