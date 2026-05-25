import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/types.gen";

/**
 * Soft-delete / restore / hard-delete helpers for the reusable CRUD stack
 * (E1.1 / #583).
 *
 * Per the guardrails (plan "Delete = soft-delete"): a DELETE on a safe resource
 * sets `deleted_at = now()` (the tombstone added by the E1.2 migration to the
 * safe tables), and a restore route clears it. Both use a **compare-and-set**
 * guard so a double-archive or a restore-of-a-live-row is reported as a 409
 * conflict rather than silently succeeding:
 *
 *   - softDelete: `update(deleted_at=now()) where id=? and deleted_at is null`
 *     -> 0 rows matched means it was already archived (or missing): conflict.
 *   - restore:    `update(deleted_at=null) where id=? and deleted_at is not null`
 *     -> 0 rows matched means it was already live (or missing): conflict.
 *
 * Hard-delete is reserved for pure child config rows (no downstream FK lineage),
 * per the plan; it issues a real `delete`.
 *
 * The result is a discriminated union the route maps to HTTP:
 *   ok      -> 200 { resource: row }
 *   missing -> 404
 *   conflict-> 409 (already in the target state)
 *   error   -> 500 (unexpected DB error)
 */

type AdminClient = SupabaseClient<Database>;

export type MutationResult<Row> =
  | { kind: "ok"; row: Row }
  | { kind: "missing" }
  | { kind: "conflict"; reason: string }
  | { kind: "error"; message: string };

/**
 * Table name. Accepts any known generated table name, but stays assignable from
 * a plain `string` because the committed `types.gen.ts` is curated and does not
 * yet list every soft-deletable table the E1.2 migration touches (the client
 * config-children + `concepts` rows land in the types when they are regenerated
 * against the live DB). Typing it as `(keyof Tables) | (string & {})` keeps
 * editor autocomplete for the present tables without rejecting the rest.
 */
type TableName = keyof Database["public"]["Tables"] | (string & {});

/** Known generated table name (what the typed client's `.from()` expects). */
type KnownTable = keyof Database["public"]["Tables"];

/**
 * `supabase.from(table)` with the curated-types gap bridged: the runtime name
 * is forwarded unchanged, the cast only satisfies the compiler for tables not
 * yet present in `types.gen.ts`. Centralised so the cast lives in exactly one
 * place.
 */
function relation(supabase: AdminClient, table: TableName) {
  return supabase.from(table as KnownTable);
}

export type SoftDeleteOptions = {
  /** Tombstone column. Defaults to `deleted_at`. */
  deletedColumn?: string;
  /** ISO timestamp to stamp. Defaults to `now()`. Injectable for tests. */
  now?: string;
  /** PK column. Defaults to `id`. */
  idColumn?: string;
};

/**
 * Soft-delete one row by id. Compare-and-set: only a currently-live row
 * (`deleted_at is null`) is archived. Returns the archived row on success.
 *
 * `missing` vs `conflict`: when the update matches nothing we re-read the row to
 * disambiguate. A row that exists but is already archived is a `conflict`; a
 * row that does not exist at all is `missing`.
 */
export async function softDelete<Row = Record<string, unknown>>(
  supabase: AdminClient,
  table: TableName,
  id: string,
  options: SoftDeleteOptions = {},
): Promise<MutationResult<Row>> {
  const { deletedColumn = "deleted_at", idColumn = "id", now = new Date().toISOString() } = options;

  const { data, error } = await relation(supabase, table)
    .update({ [deletedColumn]: now } as never)
    .eq(idColumn, id)
    .is(deletedColumn, null)
    .select()
    .maybeSingle();

  if (error) return { kind: "error", message: error.message };
  if (data) return { kind: "ok", row: data as Row };

  // 0 rows updated: distinguish missing from already-archived.
  return disambiguate<Row>(supabase, table, id, idColumn, deletedColumn, "already_archived");
}

/**
 * Restore a soft-deleted row by id. Compare-and-set: only a currently-archived
 * row (`deleted_at is not null`) is restored. Returns the restored row.
 */
export async function restore<Row = Record<string, unknown>>(
  supabase: AdminClient,
  table: TableName,
  id: string,
  options: SoftDeleteOptions = {},
): Promise<MutationResult<Row>> {
  const { deletedColumn = "deleted_at", idColumn = "id" } = options;

  const { data, error } = await relation(supabase, table)
    .update({ [deletedColumn]: null } as never)
    .eq(idColumn, id)
    .not(deletedColumn, "is", null)
    .select()
    .maybeSingle();

  if (error) return { kind: "error", message: error.message };
  if (data) return { kind: "ok", row: data as Row };

  return disambiguate<Row>(supabase, table, id, idColumn, deletedColumn, "not_archived");
}

/**
 * Hard-delete one row by id. For PURE child config rows only (no soft-delete
 * tombstone, no downstream lineage). The plan reserves this for child rows
 * such as a single `client_value_props` entry the operator removes outright.
 * Returns the deleted row on success, `missing` when nothing matched.
 */
export async function hardDelete<Row = Record<string, unknown>>(
  supabase: AdminClient,
  table: TableName,
  id: string,
  options: { idColumn?: string } = {},
): Promise<MutationResult<Row>> {
  const { idColumn = "id" } = options;

  const { data, error } = await relation(supabase, table)
    .delete()
    .eq(idColumn, id)
    .select()
    .maybeSingle();

  if (error) return { kind: "error", message: error.message };
  if (data) return { kind: "ok", row: data as Row };
  return { kind: "missing" };
}

/**
 * After a compare-and-set update matches 0 rows, re-read the row to decide
 * whether it was missing (404) or already in the target state (409).
 */
async function disambiguate<Row>(
  supabase: AdminClient,
  table: TableName,
  id: string,
  idColumn: string,
  deletedColumn: string,
  conflictReason: string,
): Promise<MutationResult<Row>> {
  const { data, error } = await relation(supabase, table)
    .select(`${idColumn}, ${deletedColumn}`)
    .eq(idColumn, id)
    .maybeSingle();

  if (error) return { kind: "error", message: error.message };
  if (!data) return { kind: "missing" };
  return { kind: "conflict", reason: conflictReason };
}
