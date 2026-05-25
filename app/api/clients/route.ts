import { type NextRequest } from "next/server";

import {
  applyListQuery,
  badJson,
  conflict,
  created,
  emitEvent,
  eventKind,
  ok,
  parseListQuery,
  paginationMeta,
  serverError,
  zodError,
  type FilterableQuery,
} from "@/lib/crud";
import { CreateClientInput, type ClientInsert } from "@/lib/clients/schemas";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/types.gen";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Columns a client may filter / sort by. */
const FILTERABLE = ["status", "service_type", "created_at", "name", "slug"] as const;
/** Columns the `?q=` free-text searches. */
const SEARCHABLE = ["name", "slug"] as const;

/**
 * GET /api/clients
 *
 * Two modes, selected by the `paginate` query flag, so the existing
 * dropdown-picker callers keep working while the new Clients list view gets
 * full filter/sort/paginate:
 *
 *  - Legacy mode (default): returns `{ clients: [...] }` ordered active-first
 *    then alphabetically, for the brief/pipeline client pickers. Excludes
 *    archived rows. No pagination.
 *  - List mode (`?paginate=1`): returns `{ clients, page }` with the standard
 *    list envelope (filter by status/service_type, sort, paginate, free-text
 *    over name/slug). Soft-deleted rows are excluded.
 *
 * Reads via the service-role client (bypasses RLS). Read-only.
 */
export async function GET(req: NextRequest) {
  const supabase = createAdminClient();
  const url = new URL(req.url);

  if (url.searchParams.get("paginate") === "1") {
    const list = parseListQuery(url.searchParams, {
      filterable: FILTERABLE,
      searchable: SEARCHABLE,
      defaultSort: "created_at",
      defaultDir: "desc",
    });

    const base = supabase
      .from("clients")
      .select("id, name, slug, service_type, status, created_at, deleted_at", {
        count: "exact",
      });
    const query = applyListQuery(base as unknown as FilterableQuery<typeof base>, list, {
      searchable: SEARCHABLE,
    }) as unknown as typeof base;

    const { data, error, count } = await query;
    if (error) return serverError(error);

    return ok({ clients: data ?? [], page: paginationMeta(list, count ?? null) });
  }

  // Legacy picker mode.
  const { data, error } = await supabase
    .from("clients")
    .select("id, name, slug, service_type, status")
    .is("deleted_at", null)
    .order("status", { ascending: true })
    .order("name", { ascending: true });

  if (error) return serverError(error);

  const rows = data ?? [];
  const clients = [...rows].sort((a, b) => {
    const aActive = a.status === "active" ? 0 : 1;
    const bActive = b.status === "active" ? 0 : 1;
    if (aActive !== bActive) return aActive - bActive;
    return a.name.localeCompare(b.name);
  });

  return ok({ clients });
}

/**
 * POST /api/clients
 *
 * Creates a client. Validates the body, inserts the row, and emits a
 * `client_created` audit event. A duplicate slug (the DB unique index) surfaces
 * as 409 rather than a raw 500.
 */
export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return badJson();
  }

  const parsed = CreateClientInput.safeParse(body);
  if (!parsed.success) return zodError(parsed.error);

  const supabase = createAdminClient();
  const insert: ClientInsert = {
    slug: parsed.data.slug,
    name: parsed.data.name,
    service_type: parsed.data.service_type,
    status: parsed.data.status,
    brand_colors: (parsed.data.brand_colors ?? null) as Json | null,
    cpl_target: parsed.data.cpl_target ?? null,
    ghl_location_id: parsed.data.ghl_location_id ?? null,
    meta_account_id: parsed.data.meta_account_id ?? null,
    drive_root_folder_id: parsed.data.drive_root_folder_id ?? null,
  };

  const { data: client, error } = await supabase.from("clients").insert(insert).select().single();

  if (error || !client) {
    // 23505 = unique_violation (slug already taken).
    if (error?.code === "23505" || /duplicate key|unique/i.test(error?.message ?? "")) {
      return conflict("slug_taken", { slug: parsed.data.slug });
    }
    return serverError(error ?? "insert failed");
  }

  await emitEvent(supabase, {
    kind: eventKind("client", "created"),
    refTable: "clients",
    refId: client.id,
    payload: { slug: client.slug, name: client.name } as Json,
  });

  return created({ client });
}
