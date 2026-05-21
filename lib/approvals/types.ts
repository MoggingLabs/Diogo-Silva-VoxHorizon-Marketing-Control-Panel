/**
 * Shared types + zod schemas for the operator-side approval flow (HI-16).
 *
 * The `approvals` + `approvals_policy_cache` tables landed in migration 0008
 * (HI-15) but the generated `types.gen.ts` has not been re-run yet. Until
 * Wave 22 regenerates the types, declare strongly-typed shapes here so the
 * approval components/routes can use them without `any` casts.
 *
 * Source of truth for the enum values is `db/migrations/0008_hermes_integration.sql`.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

/** `approval_status_enum`. */
export const ApprovalStatusEnum = z.enum(["pending", "decided", "expired", "cancelled"]);
export type ApprovalStatus = z.infer<typeof ApprovalStatusEnum>;

/** `approval_decision_enum`. */
export const ApprovalDecisionEnum = z.enum(["approved", "rejected", "approved_with_caveat"]);
export type ApprovalDecision = z.infer<typeof ApprovalDecisionEnum>;

/**
 * `approvals.risk_class` is a free-text column, but the Hermes plugin writes
 * one of four known values. We keep the union loose (`string`) on the read
 * side and `RiskClassEnum` on the write side.
 */
export const RiskClassEnum = z.enum(["spend", "external-write", "filesystem", "unknown"]);
export type ApprovalRiskClass = z.infer<typeof RiskClassEnum>;

// ---------------------------------------------------------------------------
// Row shape
// ---------------------------------------------------------------------------

/**
 * Per-approval context object the Hermes plugin attaches. All fields are
 * optional; the UI degrades gracefully when none are present.
 */
export interface ApprovalContext {
  pipeline_id?: string;
  brief_id?: string;
  creative_id?: string;
  skill_name?: string;
  estimated_cost?: number;
  /** Forward-compat escape hatch for fields the plugin may add later. */
  [key: string]: unknown;
}

/**
 * One row of the `approvals` table. Mirrors the SQL exactly — fields that
 * are nullable in the DB are `T | null` here.
 */
export interface Approval {
  id: string;
  ekko_session_id: string;
  ekko_tool_call_id: string;
  tool_name: string;
  tool_args: Record<string, unknown>;
  risk_class: ApprovalRiskClass | string | null;
  context: ApprovalContext | null;
  requested_at: string;
  expires_at: string;
  status: ApprovalStatus;
  decision: ApprovalDecision | null;
  decided_by: string | null;
  decided_at: string | null;
  decision_notes: string | null;
  cache_for_session: boolean | null;
  cache_for_minutes: number | null;
  worker_received_at: string | null;
  /**
   * Enrichment attached by `GET /api/approvals` (not a DB column). Resolved
   * from the approval's pipeline id -> `pipelines.client_id` -> `clients.name`.
   * `null` when the approval has no pipeline or the client can't be resolved.
   */
  client_name?: string | null;
  /** The pipeline id pulled from `tool_args`/`context`, when present. */
  pipeline_id?: string | null;
}

// ---------------------------------------------------------------------------
// Decision input
// ---------------------------------------------------------------------------

/**
 * Body of `POST /api/approvals/:id/decision`.
 *
 * `cache_for_minutes` defaults to 240 (4h) — matching the operator default for
 * "approve and remember for session". The server clamps it to `[1, 1440]` so
 * the cache never lives longer than 24h.
 */
export const DecisionInput = z.object({
  decision: ApprovalDecisionEnum,
  notes: z.string().max(2000).optional(),
  cache_for_session: z.boolean().optional().default(false),
  cache_for_minutes: z.number().int().min(1).max(1440).optional(),
});
export type DecisionInputT = z.infer<typeof DecisionInput>;

/**
 * Query string for `GET /api/approvals` and the audit page list. All
 * optional; the route defaults to "pending only, newest first" when
 * `status` isn't set.
 */
export const ApprovalsQuery = z.object({
  status: ApprovalStatusEnum.optional(),
  session: z.string().min(1).optional(),
  tool: z.string().min(1).optional(),
  decision: ApprovalDecisionEnum.optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
export type ApprovalsQueryT = z.infer<typeof ApprovalsQuery>;
