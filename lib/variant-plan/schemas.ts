import { z } from "zod";

import type { Database } from "@/lib/supabase/types.gen";

/**
 * Variant-plan + variant-plan-cell editor schemas (E5.2 / #596).
 *
 * The operator crafts the A/B test plan in the `variant_plan` stage: one
 * `variant_plan` per pipeline carrying the test variable + hypothesis, and a
 * set of `variant_plan_cell` rows (the matrix cells: creative + copy_variant +
 * audience + label). These schemas back the editor routes that let the operator
 * author the plan BEFORE the approve/reject decision (which stays in the
 * existing `variant-plan/decision` route and re-derives nothing here — it only
 * stamps the verdict).
 *
 * Mutation surface respects the guardrails:
 *   - `variant_plan` carries a `deleted_at` tombstone (0047) but the plan is
 *     1:1 with the pipeline + owned by the stage, so we never archive it from
 *     the editor — we upsert its draft fields. Status is owned by the decision
 *     route.
 *   - `variant_plan_cell` is a PURE child config row (cascade from the plan, no
 *     tombstone), so a removed cell is a real hard-delete per the plan's
 *     "hard-delete only for pure child config rows".
 *   - The editor refuses to mutate a plan whose status is `approved` (409): an
 *     approved plan is locked; the manager must re-open via a reject decision.
 */

export const VARIANT_TEST_VARIABLES = ["creative", "copy", "audience"] as const;
export type VariantTestVariable = (typeof VARIANT_TEST_VARIABLES)[number];

/**
 * PUT /api/pipelines/:id/variant-plan — upsert the plan's draft fields.
 * Creating the plan if absent. `test_variable` is required (the test is "one
 * variable per plan"); `hypothesis` is optional free text.
 */
export const VariantPlanUpsertInput = z.object({
  test_variable: z.enum(VARIANT_TEST_VARIABLES),
  hypothesis: z.string().max(2000).nullable().optional(),
});
export type VariantPlanUpsertInputT = z.infer<typeof VariantPlanUpsertInput>;

/** A free-form audience targeting object stored on a cell (jsonb). */
const AudienceSchema = z.record(z.string(), z.unknown());

/**
 * POST /api/pipelines/:id/variant-plan/cells — create one cell.
 * `cell_index` defaults to "append" when omitted (the route computes the next
 * free index). The references are nullable (an audience-variable test may have
 * no creative/copy pinned per cell, etc.).
 */
export const VariantPlanCellCreateInput = z.object({
  cell_index: z.number().int().min(0).optional(),
  creative_id: z.string().uuid().nullable().optional(),
  copy_variant_id: z.string().uuid().nullable().optional(),
  audience: AudienceSchema.nullable().optional(),
  label: z.string().max(120).nullable().optional(),
});
export type VariantPlanCellCreateInputT = z.infer<typeof VariantPlanCellCreateInput>;

/**
 * PATCH /api/pipelines/:id/variant-plan/cells/:cellId — edit one cell. Every
 * field optional; at least one must be present.
 */
export const VariantPlanCellUpdateInput = z
  .object({
    cell_index: z.number().int().min(0).optional(),
    creative_id: z.string().uuid().nullable().optional(),
    copy_variant_id: z.string().uuid().nullable().optional(),
    audience: AudienceSchema.nullable().optional(),
    label: z.string().max(120).nullable().optional(),
  })
  .refine((d) => Object.keys(d).length > 0, { message: "nothing to update" });
export type VariantPlanCellUpdateInputT = z.infer<typeof VariantPlanCellUpdateInput>;

// ---------------------------------------------------------------------------
// Row re-exports
// ---------------------------------------------------------------------------

export type VariantPlanRow = Database["public"]["Tables"]["variant_plan"]["Row"];
export type VariantPlanInsert = Database["public"]["Tables"]["variant_plan"]["Insert"];
export type VariantPlanUpdate = Database["public"]["Tables"]["variant_plan"]["Update"];
export type VariantPlanCellRow = Database["public"]["Tables"]["variant_plan_cell"]["Row"];
export type VariantPlanCellInsert = Database["public"]["Tables"]["variant_plan_cell"]["Insert"];
export type VariantPlanCellUpdate = Database["public"]["Tables"]["variant_plan_cell"]["Update"];
