import { z } from "zod";

/**
 * Zod schemas for the human-decision routes the dashboard owns in P4:
 *   - variant_plan → approve / reject the A/B test plan,
 *   - launch_handoff → the HARD launch gate (PAUSED-first, preconditions),
 *   - monitor → kill / scale verdict.
 *
 * Each route forwards its decision to the worker / records the move; the
 * schemas keep the contract in one place so the route + the client agree.
 */

/** Body for `POST /api/pipelines/:id/variant-plan/decision`. */
export const VariantPlanDecisionInput = z
  .object({
    decision: z.enum(["approved", "rejected"]),
    notes: z.string().max(5000).optional(),
  })
  .refine(
    (d) => d.decision === "approved" || (typeof d.notes === "string" && d.notes.trim().length > 0),
    { message: "notes are required to reject the variant plan", path: ["notes"] },
  );
export type VariantPlanDecisionInputT = z.infer<typeof VariantPlanDecisionInput>;

/**
 * Body for `POST /api/pipelines/:id/launch/decision` — the HARD launch gate.
 *
 * `confirm_paused_first` MUST be true: the operator never spends live; Meta
 * entities are created PAUSED first. `acknowledge_preconditions` asserts the
 * manager saw the spec-pass ∧ compliance-clear ∧ ≥3-copy checklist. A reject
 * cancels the launch; notes are required to reject.
 */
export const LaunchDecisionInput = z
  .object({
    decision: z.enum(["approved", "rejected"]),
    confirm_paused_first: z.boolean().optional(),
    acknowledge_preconditions: z.boolean().optional(),
    notes: z.string().max(5000).optional(),
  })
  .superRefine((d, ctx) => {
    if (d.decision === "rejected") {
      if (!d.notes || d.notes.trim().length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["notes"],
          message: "notes are required to reject a launch",
        });
      }
      return;
    }
    // approve branch: both confirmations are mandatory.
    if (d.confirm_paused_first !== true) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["confirm_paused_first"],
        message: "launch must be PAUSED-first — confirm to proceed",
      });
    }
    if (d.acknowledge_preconditions !== true) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["acknowledge_preconditions"],
        message: "acknowledge the launch preconditions to proceed",
      });
    }
  });
export type LaunchDecisionInputT = z.infer<typeof LaunchDecisionInput>;

/**
 * Body for `POST /api/pipelines/:id/monitor/decision`: the kill/scale verdict.
 * Both verdicts move the run to `done` and ENQUEUE an operator dispatch that
 * EXECUTES the approved action on Meta (operator-held MCP):
 *   - `kill`  -> pause the live campaign (ads_update_entity -> status PAUSED).
 *   - `scale` -> raise the winning campaign's daily budget (ads_update_entity
 *     -> daily_budget = `target_budget`).
 * Both verdicts accept optional notes; an optional `campaign_id` scopes a
 * per-campaign verdict when the manager acts on a single campaign. `scale`
 * carries an optional `target_budget` (the new daily budget, minor currency
 * units, e.g. cents) the operator writes to Meta.
 */
export const MonitorDecisionInput = z.object({
  decision: z.enum(["kill", "scale"]),
  campaign_id: z.string().max(200).optional(),
  notes: z.string().max(5000).optional(),
  target_budget: z.number().positive().optional(),
});
export type MonitorDecisionInputT = z.infer<typeof MonitorDecisionInput>;
