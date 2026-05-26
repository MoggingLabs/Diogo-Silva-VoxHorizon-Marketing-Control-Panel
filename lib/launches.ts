import { z } from "zod";

import type { Database, Json } from "@/lib/supabase/types.gen";

/**
 * Image launch package: zod schemas + status state machine.
 *
 * A ``launch_packages`` row is the operator's go/no-go bundle for one
 * approved brief. The shape:
 *
 *   - ``brief_id``  →  FK to the approved image brief
 *   - ``status``    →  "validating" | "posted" | "approved" |
 *                       "approved_with_changes" | "rejected" | "failed"
 *   - ``payload``   →  jsonb snapshot of the brief + creatives + copy
 *                       + targeting + budget + validation issues at the
 *                       time the package was assembled.
 *
 * The builder API (``POST /api/launches``) takes a ``brief_id``, runs
 * pre-flight checks (all creatives approved, paired copy, Drive paths
 * present), and inserts a row in status ``validating`` → ``posted`` (or
 * ``failed`` if pre-flight didn't pass).
 *
 * The decision API (``POST /api/launches/:id/decision``) is the approval
 * gate: terminal ``approved`` / ``approved_with_changes`` / ``rejected``.
 */

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** POST /api/launches body. */
export const LaunchInput = z.object({
  brief_id: z.string().uuid("brief_id must be a uuid"),
  /**
   * Optional pipeline handoff: when present, the launch package is linked
   * back to the originating pipeline by updating
   * ``pipelines.launch_package_id`` after insertion (and a
   * ``pipeline_events(kind='launch_linked')`` row is emitted). The pipeline
   * MUST be in status ``done`` — otherwise the route returns 422.
   */
  pipeline_id: z.string().uuid("pipeline_id must be a uuid").optional(),
});
export type LaunchInputT = z.infer<typeof LaunchInput>;

/** Three terminal decisions on the approval gate. */
export const LaunchDecision = z.enum(["approved", "approved_with_changes", "rejected"]);
export type LaunchDecisionT = z.infer<typeof LaunchDecision>;

/**
 * POST /api/launches/:id/decision body.
 *
 * Notes required for any non-clean approval — mirrors the brief-side rule.
 */
export const LaunchDecisionInput = z
  .object({
    decision: LaunchDecision,
    notes: z.string().max(5000).optional(),
  })
  .refine(
    (d) => d.decision === "approved" || (typeof d.notes === "string" && d.notes.trim().length > 0),
    { message: "notes are required for approved_with_changes and rejected", path: ["notes"] },
  );
export type LaunchDecisionInputT = z.infer<typeof LaunchDecisionInput>;

/**
 * PATCH /api/launches/:id body — the operator package edit (E5.1 / #595).
 *
 * Launch packages are SAFE artifacts the operator can edit (the plan's "full
 * edit + soft-archive"), but the launch DECISION still flows through the
 * decision route (which re-derives the gate). So the editable surface here is
 * intentionally limited to the operator's free-form annotation
 * (``decided_notes``) — never ``status`` (that is the decision gate) and never
 * the ad_entity graph (worker/Meta-owned). At least one field must be present.
 */
export const LaunchPackageUpdateInput = z
  .object({
    decided_notes: z.string().max(5000).nullable().optional(),
  })
  .refine((d) => Object.keys(d).length > 0, { message: "nothing to update" });
export type LaunchPackageUpdateInputT = z.infer<typeof LaunchPackageUpdateInput>;

// ---------------------------------------------------------------------------
// Status state machine
// ---------------------------------------------------------------------------

export const LaunchStatus = z.enum([
  "validating",
  "posted",
  "approved",
  "approved_with_changes",
  "rejected",
  "failed",
]);
export type LaunchStatusT = z.infer<typeof LaunchStatus>;

/**
 * Allowed transitions. The builder API moves rows from ``validating`` to
 * either ``posted`` (success) or ``failed`` (pre-flight checks reported
 * issues). The decision endpoint moves ``posted`` to a terminal state.
 */
export const allowedTransitions: Record<LaunchStatusT, LaunchStatusT[]> = {
  validating: ["posted", "failed"],
  posted: ["approved", "approved_with_changes", "rejected"],
  approved: [],
  approved_with_changes: [],
  rejected: [],
  failed: [],
};

export function canTransitionLaunch(from: LaunchStatusT, to: LaunchStatusT): boolean {
  if (from === to) return true;
  return allowedTransitions[from]?.includes(to) ?? false;
}

// ---------------------------------------------------------------------------
// Pre-flight issue surface — the "what's missing" list returned to the UI
// ---------------------------------------------------------------------------

export const LaunchIssueSeverity = z.enum(["error", "warning"]);
export type LaunchIssueSeverityT = z.infer<typeof LaunchIssueSeverity>;

export const LaunchIssue = z.object({
  severity: LaunchIssueSeverity,
  message: z.string(),
  ref_table: z.string().optional(),
  ref_id: z.string().optional(),
});
export type LaunchIssueT = z.infer<typeof LaunchIssue>;

/**
 * Snapshot we write into ``launch_packages.payload``. Captures everything
 * needed to render the launch detail page without N+1 queries.
 */
/**
 * Per-creative asset reference resolved at build time. ``url`` is the Drive
 * URL (legacy Ekko flow) when present, otherwise a freshly signed Supabase
 * Storage URL (operator/codex flow, where finals live in Supabase and have no
 * ``file_path_drive``). ``source`` records which backend the URL came from so
 * the launch detail page can label it. ``url`` may be null if a Supabase-stored
 * creative failed to sign (the preflight surfaces that as an issue).
 */
export const LaunchAssetRef = z.object({
  creative_id: z.string().uuid(),
  source: z.enum(["drive", "supabase"]),
  url: z.string().nullable(),
});
export type LaunchAssetRefT = z.infer<typeof LaunchAssetRef>;

export const LaunchPayload = z.object({
  brief_id_human: z.string(),
  client: z
    .object({
      id: z.string(),
      slug: z.string(),
      name: z.string(),
    })
    .nullable(),
  creative_ids: z.array(z.string().uuid()),
  copy_variant_ids: z.array(z.string().uuid()),
  /** Resolved asset URLs (Drive or signed Supabase) keyed by creative. */
  asset_refs: z.array(LaunchAssetRef).default([]),
  issues: z.array(LaunchIssue).default([]),
  validation: z.object({
    ok: z.boolean(),
    via: z.enum(["preflight", "scripts_runner"]),
    raw_stdout: z.string().optional(),
    raw_stderr: z.string().optional(),
  }),
});
export type LaunchPayloadT = z.infer<typeof LaunchPayload>;

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------

export type LaunchPackage = Database["public"]["Tables"]["launch_packages"]["Row"];
export type LaunchPackageInsert = Database["public"]["Tables"]["launch_packages"]["Insert"];
export type LaunchPackageUpdate = Database["public"]["Tables"]["launch_packages"]["Update"];

/** Parse the jsonb payload column into our typed shape, or ``null`` on miss. */
export function readLaunchPayload(row: Pick<LaunchPackage, "payload">): LaunchPayloadT | null {
  const parsed = LaunchPayload.safeParse(row.payload);
  return parsed.success ? parsed.data : null;
}

/** Coerce a typed payload back into a Json-compatible value for inserts. */
export function payloadToJson(p: LaunchPayloadT): Json {
  return JSON.parse(JSON.stringify(p)) as Json;
}
