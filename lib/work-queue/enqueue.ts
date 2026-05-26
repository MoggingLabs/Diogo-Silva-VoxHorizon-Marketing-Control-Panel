import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import type { Json, TablesInsert } from "@/lib/supabase/types.gen";

/**
 * The canonical work-queue enqueue helper (silent-failure redesign PR-1).
 *
 * Every dashboard route that needs background work calls THIS function and
 * nothing else. The single chokepoint is how the redesign closes the
 * fire-and-forget class: a route can no longer write a transition event
 * without a backing row, because every route enqueues a work_item synchronously
 * and the auto-emit trigger in migration 0050 emits the pipeline_event for it.
 *
 * Contract:
 *  - INSERTs into `work_item` at status='queued'. The `work_item_emit_pipeline_event`
 *    trigger then writes ONE `pipeline_events` row -- routes MUST NOT also
 *    write that event (would double-log and resurrect the "two writes that
 *    can drift" class the redesign closes).
 *  - On a unique-conflict on `idempotency_key`, SELECTs the existing row and
 *    returns `{ id, duplicate: true }`. Two enqueues with the same key are
 *    the same logical work; a router retry never double-dispatches.
 *  - Throws on any other DB error so the calling route can return 5xx and
 *    roll back any state it just wrote. No silent fire-and-forget.
 *
 * PR-1 ships this helper plumbing-only -- no route calls it yet. Routes
 * convert in PR-2 (dual-write) and the legacy fire-and-forget paths delete
 * in PR-4 (deletion migration 0051).
 */

/**
 * Stable union of the `work_item_kind` enum from migration 0050. Mirrored
 * here so the dashboard rejects an invalid kind at the TS boundary -- the DB
 * enum is defence-in-depth, but a build-time error beats a 500 every time.
 */
export type WorkItemKind =
  | "operator_dispatch"
  | "outbox_meta_record_launch"
  | "outbox_drive_finalize_verified"
  | "outbox_ghl_send"
  | "kie_video_render"
  | "kie_image_render"
  | "kie_tts"
  | "ffmpeg_compose"
  | "worker_ideation"
  | "worker_generation"
  | "worker_monitor"
  | "broll_search"
  | "other";

export type EnqueueWorkItemOpts = {
  kind: WorkItemKind;
  pipelineId?: string;
  creativeId?: string;
  briefId?: string;
  payload: Record<string, unknown>;
  /**
   * Stable dedup key. Two enqueues with the same key resolve to the same
   * row (returns `{ duplicate: true }`). Per-kind conventions:
   *  - `operator_dispatch`: `op-disp:<pipeline_id>:<stage>:<nonce>`
   *  - `outbox_*`:          `<integration>:<op>:<domain_natural_key>`
   *  - `kie_*_render`:      `kie:<task_id>`
   */
  idempotencyKey: string;
  /** Provenance: the route or module that enqueued this. Greppable. */
  createdBy: string;
  /** Set on watchdog retries to chain the retry trail. */
  parentWorkItemId?: string;
};

export type EnqueueWorkItemResult = {
  id: string;
  duplicate: boolean;
};

/**
 * Whether a Postgres error code/message looks like a unique-constraint
 * conflict on `idempotency_key`. The Supabase JS client surfaces the
 * underlying PostgREST shape; we check both the SQLSTATE 23505 and the
 * familiar text fragments so a small change in error formatting doesn't
 * silently flip dedup behaviour to "throw on every retry".
 */
function isUniqueConflict(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { code?: unknown; message?: unknown };
  if (e.code === "23505") return true;
  if (typeof e.message === "string") {
    const m = e.message.toLowerCase();
    if (m.includes("idempotency_key") && m.includes("unique")) return true;
    if (m.includes("duplicate key") && m.includes("idempotency_key")) return true;
  }
  return false;
}

export async function enqueueWorkItem(opts: EnqueueWorkItemOpts): Promise<EnqueueWorkItemResult> {
  const sb = createAdminClient();

  // Probe-then-insert: a duplicate idempotency_key is a SELECT, not an
  // INSERT, so we don't churn the audit trail on every duplicate kick. The
  // UNIQUE constraint backs us up if a race beats the probe (see below).
  const probe = await sb
    .from("work_item")
    .select("id")
    .eq("idempotency_key", opts.idempotencyKey)
    .maybeSingle();

  if (probe.error && probe.error.code !== "PGRST116") {
    // PGRST116 = "JSON object requested, multiple (or no) rows returned" --
    // maybeSingle's "no row" shape is NOT an error; any other code is.
    throw new Error(`work_item probe failed: ${probe.error.message ?? "unknown error"}`);
  }
  if (probe.data?.id) {
    return { id: String(probe.data.id), duplicate: true };
  }

  const row: TablesInsert<"work_item"> = {
    kind: opts.kind,
    status: "queued",
    // Payload is supplied as a Record<string, unknown> at the API boundary and
    // serialized as JSON on the wire; cast through `Json` so the strongly-
    // typed Insert accepts the open record without losing the runtime shape.
    payload: opts.payload as unknown as Json,
    idempotency_key: opts.idempotencyKey,
    created_by: opts.createdBy,
  };
  if (opts.pipelineId !== undefined) row.pipeline_id = opts.pipelineId;
  if (opts.creativeId !== undefined) row.creative_id = opts.creativeId;
  if (opts.briefId !== undefined) row.brief_id = opts.briefId;
  if (opts.parentWorkItemId !== undefined) {
    row.parent_work_item_id = opts.parentWorkItemId;
  }

  const inserted = await sb.from("work_item").insert(row).select("id").maybeSingle();

  if (inserted.error) {
    if (isUniqueConflict(inserted.error)) {
      // Race: another caller inserted between our probe and our insert. Re-
      // read the winner and return it as a duplicate so the caller is
      // idempotent regardless of which side of the race it was on.
      const again = await sb
        .from("work_item")
        .select("id")
        .eq("idempotency_key", opts.idempotencyKey)
        .maybeSingle();
      if (again.data?.id) {
        return { id: String(again.data.id), duplicate: true };
      }
      // The conflict said someone wrote a row but we cannot find it -- this
      // is a real consistency error, not a silent dedup.
      throw new Error(
        `work_item insert conflicted on idempotency_key but the existing row was not readable: ${
          again.error?.message ?? "unknown"
        }`,
      );
    }
    throw new Error(`work_item insert failed: ${inserted.error.message ?? "unknown error"}`);
  }
  if (!inserted.data?.id) {
    throw new Error(
      "work_item insert succeeded but returned no id (RLS / select grant misconfigured?)",
    );
  }
  return { id: String(inserted.data.id), duplicate: false };
}
