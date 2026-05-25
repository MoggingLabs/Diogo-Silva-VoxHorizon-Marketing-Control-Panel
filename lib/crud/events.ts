import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database, Json } from "@/lib/supabase/types.gen";

/**
 * Audit-event emit helper for the reusable CRUD stack (E1.1 / #583).
 *
 * The `events` table (0001) is the lightweight append-only domain audit log:
 *   { kind, ref_table, ref_id, payload }
 *
 * Every CRUD mutation emits one event (`<resource>_created` /
 * `<resource>_updated` / `<resource>_archived` / `<resource>_restored`). The
 * emit is deliberately **non-fatal**: the row mutation is the primary artifact,
 * so a failed event insert is logged and swallowed, never surfaced as a 500,
 * matching the canonical routes (`app/api/briefs/[id]/route.ts`,
 * `app/api/pipelines/route.ts`).
 */

export type EventInsert = Database["public"]["Tables"]["events"]["Insert"];

/** Admin Supabase client (service-role). Narrowed to what we touch. */
type AdminClient = SupabaseClient<Database>;

export type EmitEventInput = {
  /** Event kind, e.g. `client_created` / `brief_archived`. */
  kind: string;
  /** Source table this event is about (the `ref_table` discriminator). */
  refTable: string;
  /** Row id this event is about. */
  refId: string;
  /** Optional structured payload (e.g. `{ from, to }`). */
  payload?: Json | null;
};

/**
 * Insert one audit event. Returns `true` on success, `false` (after logging a
 * warning) on failure. Never throws and never rejects, so callers do not await
 * a failure path that can break the request.
 */
export async function emitEvent(supabase: AdminClient, input: EmitEventInput): Promise<boolean> {
  const row: EventInsert = {
    kind: input.kind,
    ref_table: input.refTable,
    ref_id: input.refId,
    payload: input.payload ?? null,
  };

  const { error } = await supabase.from("events").insert(row);
  if (error) {
    console.warn(`[crud.emitEvent] event insert failed (${input.kind}): ${error.message}`);
    return false;
  }
  return true;
}

/**
 * Insert several audit events in one round-trip (e.g. a status transition plus
 * a payload-change event). Same non-fatal contract as `emitEvent`. A no-op
 * (returns true) when given an empty list.
 */
export async function emitEvents(
  supabase: AdminClient,
  inputs: EmitEventInput[],
): Promise<boolean> {
  if (inputs.length === 0) return true;
  const rows: EventInsert[] = inputs.map((input) => ({
    kind: input.kind,
    ref_table: input.refTable,
    ref_id: input.refId,
    payload: input.payload ?? null,
  }));

  const { error } = await supabase.from("events").insert(rows);
  if (error) {
    console.warn(`[crud.emitEvents] batch event insert failed: ${error.message}`);
    return false;
  }
  return true;
}

/**
 * Canonical event-kind builder so resources name events consistently:
 *   eventKind("client", "created") -> "client_created".
 */
export function eventKind(
  resource: string,
  action: "created" | "updated" | "archived" | "restored" | "deleted",
): string {
  return `${resource}_${action}`;
}
