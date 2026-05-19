/**
 * Shared types + zod schemas for the operator-controlled approval mode toggle.
 *
 * The dashboard's Settings tab can flip the plugin's behavior between three
 * modes (see ``db/migrations/0009_approval_mode.sql``):
 *
 *   * ``ASK``          — long-poll the dashboard for an operator decision
 *   * ``AUTO_APPROVE`` — allow without asking, TTL-bounded (1h .. 24h)
 *   * ``HALT``         — block every approval-needing tool
 *
 * The state lives in a Supabase ``approval_mode`` singleton row; transitions
 * are logged to ``approval_mode_audit``.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Mode enum + TTL bounds
// ---------------------------------------------------------------------------

export const ApprovalModeEnum = z.enum(["ASK", "AUTO_APPROVE", "HALT"]);
export type ApprovalMode = z.infer<typeof ApprovalModeEnum>;

/** Min / max TTL the operator can pick for AUTO_APPROVE, in seconds. */
export const MIN_TTL_SECONDS = 60; // 1 min — prevents accidental no-op toggles
export const MAX_TTL_SECONDS = 86_400; // 24 h — anything longer should be a config change

/**
 * The four TTL choices the Settings UI surfaces. Operators pick one from
 * the radio buttons; the underlying API accepts any value in
 * [MIN_TTL_SECONDS, MAX_TTL_SECONDS] so future presets can change here
 * without a server-side migration.
 */
export const TTL_PRESETS: ReadonlyArray<{ label: string; seconds: number }> = [
  { label: "1 hour", seconds: 60 * 60 },
  { label: "4 hours", seconds: 4 * 60 * 60 },
  { label: "12 hours", seconds: 12 * 60 * 60 },
  { label: "24 hours", seconds: 24 * 60 * 60 },
] as const;

// ---------------------------------------------------------------------------
// Row shapes mirroring the worker's response
// ---------------------------------------------------------------------------

/** Current mode response — singleton row from the worker. */
export interface ApprovalModeState {
  mode: ApprovalMode | string;
  expires_at: string | null;
  set_by: string | null;
  set_at: string;
  note: string | null;
}

/** One row of the audit list. */
export interface ApprovalModeAuditEntry {
  id: string;
  from_mode: string;
  to_mode: string;
  ttl_seconds: number | null;
  changed_at: string;
  changed_by: string;
  note: string | null;
}

// ---------------------------------------------------------------------------
// PUT body schema — used by the API route + (optionally) by the UI form
// ---------------------------------------------------------------------------

/**
 * Body for ``PUT /api/approval-mode``.
 *
 * Cross-field invariants (AUTO_APPROVE needs TTL, ASK/HALT must not have
 * TTL) are enforced on the server. The schema's ``superRefine`` block
 * keeps the same invariants on the client so the UI fails-fast.
 */
export const ApprovalModeInput = z
  .object({
    mode: ApprovalModeEnum,
    ttl_seconds: z.number().int().min(MIN_TTL_SECONDS).max(MAX_TTL_SECONDS).optional(),
    note: z.string().max(2000).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.mode === "AUTO_APPROVE" && value.ttl_seconds === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["ttl_seconds"],
        message: "AUTO_APPROVE requires ttl_seconds",
      });
    }
    if (value.mode !== "AUTO_APPROVE" && value.ttl_seconds !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["ttl_seconds"],
        message: "ttl_seconds only valid for AUTO_APPROVE",
      });
    }
  });
export type ApprovalModeInputT = z.infer<typeof ApprovalModeInput>;

/**
 * Compute the milliseconds remaining until an AUTO_APPROVE row expires.
 * Returns ``0`` when the timestamp is missing, malformed, or in the past.
 */
export function ttlRemainingMs(expiresAt: string | null): number {
  if (!expiresAt) return 0;
  const t = Date.parse(expiresAt);
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, t - Date.now());
}

/** Render a remaining TTL as "03h12m" / "12m" / "expired". */
export function formatTtlShort(expiresAt: string | null): string {
  const ms = ttlRemainingMs(expiresAt);
  if (ms <= 0) return "expired";
  const totalMinutes = Math.floor(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0) {
    return `${String(hours).padStart(2, "0")}h${String(minutes).padStart(2, "0")}m`;
  }
  return `${minutes}m`;
}
