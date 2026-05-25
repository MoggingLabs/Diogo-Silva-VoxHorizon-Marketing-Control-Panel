import "server-only";

import { type NextRequest } from "next/server";

import {
  applyListQuery,
  badJson,
  conflict,
  created,
  emitEvent,
  eventKind,
  notFound,
  ok,
  parseListQuery,
  paginationMeta,
  serverError,
  softDelete,
  restore as restoreRow,
  zodError,
  type FilterableQuery,
} from "@/lib/crud";
import { CHILD_REGISTRY, type ChildKey } from "@/lib/clients/children";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/types.gen";

/**
 * Data-driven route handlers for the 1:many client config children
 * (E2.2 / #587). Each child route file is a four-line re-export that binds the
 * child key; all logic lives here so create/edit/soft-archive/restore behave
 * identically across services / value props / offers / constraints / assets /
 * past projects.
 *
 * Conventions match the canonical client routes:
 *  - writes via the service-role admin client; every mutation emits an audit
 *    event (`<resource>_created|updated|archived|restored`).
 *  - soft-delete + restore are compare-and-set (409 on a no-op).
 *  - list excludes soft-deleted rows and is scoped to the path `client_id`.
 */

type ClientCtx = { params: Promise<{ id: string }> };
type ChildCtx = { params: Promise<{ id: string; childId: string }> };

/** A loose handle on the admin client narrowed to the chaining we use. */
type Db = ReturnType<typeof createAdminClient>;

function rel(supabase: Db, table: string) {
  return supabase.from(table as "client_services");
}

/** GET list of a child resource for one client (filter/sort/paginate). */
export function makeListHandler(key: ChildKey) {
  const spec = CHILD_REGISTRY[key];
  return async function GET(req: NextRequest, ctx: ClientCtx) {
    const { id: clientId } = await ctx.params;
    const supabase = createAdminClient();
    const url = new URL(req.url);

    const list = parseListQuery(url.searchParams, {
      filterable: spec.filterable,
      searchable: spec.searchable,
      defaultSort: "sort_order",
      defaultDir: "asc",
    });

    const base = rel(supabase, spec.table)
      .select("*", { count: "exact" })
      .eq("client_id", clientId);
    const query = applyListQuery(base as unknown as FilterableQuery<typeof base>, list, {
      searchable: spec.searchable,
    }) as unknown as typeof base;

    const { data, error, count } = await query;
    if (error) return serverError(error);

    return ok({ items: data ?? [], page: paginationMeta(list, count ?? null) });
  };
}

/** POST create one child row under a client. */
export function makeCreateHandler(key: ChildKey) {
  const spec = CHILD_REGISTRY[key];
  return async function POST(req: NextRequest, ctx: ClientCtx) {
    const { id: clientId } = await ctx.params;

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return badJson();
    }

    const parsed = spec.create.safeParse(body);
    if (!parsed.success) return zodError(parsed.error);

    const supabase = createAdminClient();

    // Ensure the parent client exists (and is the FK target) so a bad client id
    // surfaces as 404, not a raw FK 500.
    const { data: client, error: clientErr } = await supabase
      .from("clients")
      .select("id")
      .eq("id", clientId)
      .maybeSingle();
    if (clientErr) return serverError(clientErr);
    if (!client) return notFound("client_not_found");

    const insert = { ...(parsed.data as Record<string, unknown>), client_id: clientId };
    const { data: row, error } = await rel(supabase, spec.table)
      .insert(insert as never)
      .select()
      .single();

    if (error || !row) return serverError(error ?? "insert failed");

    const created_row = row as { id: string };
    await emitEvent(supabase, {
      kind: eventKind(spec.resource, "created"),
      refTable: spec.table,
      refId: created_row.id,
      payload: { client_id: clientId } as Json,
    });

    return created({ item: row });
  };
}

/** PATCH edit one child row. */
export function makePatchHandler(key: ChildKey) {
  const spec = CHILD_REGISTRY[key];
  return async function PATCH(req: NextRequest, ctx: ChildCtx) {
    const { childId } = await ctx.params;

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return badJson();
    }

    const parsed = spec.update.safeParse(body);
    if (!parsed.success) return zodError(parsed.error);

    const supabase = createAdminClient();
    const { data: row, error } = await rel(supabase, spec.table)
      .update(parsed.data as never)
      .eq("id", childId)
      .is("deleted_at", null)
      .select()
      .maybeSingle();

    if (error) return serverError(error);
    if (!row) return notFound();

    await emitEvent(supabase, {
      kind: eventKind(spec.resource, "updated"),
      refTable: spec.table,
      refId: childId,
      payload: { fields: Object.keys(parsed.data as object) } as Json,
    });

    return ok({ item: row });
  };
}

/** DELETE soft-archive one child row. */
export function makeDeleteHandler(key: ChildKey) {
  const spec = CHILD_REGISTRY[key];
  return async function DELETE(_req: NextRequest, ctx: ChildCtx) {
    const { childId } = await ctx.params;
    const supabase = createAdminClient();

    const result = await softDelete(supabase, spec.table, childId);
    if (result.kind === "missing") return notFound();
    if (result.kind === "conflict") return conflict(result.reason);
    if (result.kind === "error") return serverError(result.message);

    await emitEvent(supabase, {
      kind: eventKind(spec.resource, "archived"),
      refTable: spec.table,
      refId: childId,
      payload: null,
    });

    return ok({ item: result.row });
  };
}

/** POST restore a soft-archived child row. */
export function makeRestoreHandler(key: ChildKey) {
  const spec = CHILD_REGISTRY[key];
  return async function POST(_req: NextRequest, ctx: ChildCtx) {
    const { childId } = await ctx.params;
    const supabase = createAdminClient();

    const result = await restoreRow(supabase, spec.table, childId);
    if (result.kind === "missing") return notFound();
    if (result.kind === "conflict") return conflict(result.reason);
    if (result.kind === "error") return serverError(result.message);

    await emitEvent(supabase, {
      kind: eventKind(spec.resource, "restored"),
      refTable: spec.table,
      refId: childId,
      payload: null,
    });

    return ok({ item: result.row });
  };
}
