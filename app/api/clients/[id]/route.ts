import { type NextRequest } from "next/server";

import {
  badJson,
  badRequest,
  conflict,
  emitEvent,
  eventKind,
  notFound,
  ok,
  serverError,
  softDelete,
  zodError,
} from "@/lib/crud";
import { maskIntegrations } from "@/lib/clients/integrations";
import { UpdateClientInput, type Client, type ClientUpdate } from "@/lib/clients/schemas";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/types.gen";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/** Order child rows by sort_order then created_at, active first. */
async function loadChild(
  supabase: ReturnType<typeof createAdminClient>,
  table: string,
  clientId: string,
) {
  const { data } = await supabase
    .from(table as "client_services")
    .select("*")
    .eq("client_id", clientId)
    .is("deleted_at", null)
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: true });
  return data ?? [];
}

/**
 * GET /api/clients/:id
 *
 * Full client detail in one round-trip: the client row, the 1:1 profile, every
 * 1:many config child (active only), the integrations (secrets masked), and the
 * recent activity timeline from `events` (ref_table='clients'). Returns 404 if
 * the client row is missing (archived rows still resolve so the detail page can
 * offer restore).
 */
export async function GET(_req: NextRequest, ctx: RouteContext) {
  const { id } = await ctx.params;
  const supabase = createAdminClient();

  const { data: client, error } = await supabase
    .from("clients")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (error) return serverError(error);
  if (!client) return notFound();

  const { data: profile } = await supabase
    .from("client_profiles")
    .select("*")
    .eq("client_id", id)
    .is("deleted_at", null)
    .maybeSingle();

  const [services, value_props, offers, offer_constraints, assets, past_projects, integrationsRaw] =
    await Promise.all([
      loadChild(supabase, "client_services", id),
      loadChild(supabase, "client_value_props", id),
      loadChild(supabase, "client_offers", id),
      loadChild(supabase, "client_offer_constraints", id),
      loadChild(supabase, "client_assets", id),
      loadChild(supabase, "client_past_projects", id),
      (async () => {
        const { data } = await supabase
          .from("client_integrations")
          .select("*")
          .eq("client_id", id)
          .is("deleted_at", null)
          .order("provider", { ascending: true });
        return data ?? [];
      })(),
    ]);

  const { data: events } = await supabase
    .from("events")
    .select("id, kind, payload, created_at, ref_table, ref_id")
    .eq("ref_table", "clients")
    .eq("ref_id", id)
    .order("created_at", { ascending: false })
    .limit(200);

  return ok({
    client,
    profile: profile ?? null,
    services,
    value_props,
    offers,
    offer_constraints,
    assets,
    past_projects,
    integrations: maskIntegrations(integrationsRaw),
    events: events ?? [],
  });
}

/**
 * PATCH /api/clients/:id
 *
 * Edit client identity fields. Validates the body, applies the update, and
 * emits `client_updated`. A slug collision returns 409; a missing row 404.
 */
export async function PATCH(req: NextRequest, ctx: RouteContext) {
  const { id } = await ctx.params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return badJson();
  }

  const parsed = UpdateClientInput.safeParse(body);
  if (!parsed.success) return zodError(parsed.error);

  const supabase = createAdminClient();

  const { data: current, error: fetchErr } = await supabase
    .from("clients")
    .select("id")
    .eq("id", id)
    .maybeSingle();
  if (fetchErr) return serverError(fetchErr);
  if (!current) return notFound();

  const update: ClientUpdate = {};
  const d = parsed.data;
  if (d.slug !== undefined) update.slug = d.slug;
  if (d.name !== undefined) update.name = d.name;
  if (d.service_type !== undefined) update.service_type = d.service_type;
  if (d.status !== undefined) update.status = d.status;
  if (d.brand_colors !== undefined) update.brand_colors = d.brand_colors as Json | null;
  if (d.cpl_target !== undefined) update.cpl_target = d.cpl_target;
  if (d.ghl_location_id !== undefined) update.ghl_location_id = d.ghl_location_id;
  if (d.meta_account_id !== undefined) update.meta_account_id = d.meta_account_id;
  if (d.drive_root_folder_id !== undefined) update.drive_root_folder_id = d.drive_root_folder_id;

  if (Object.keys(update).length === 0) return badRequest("nothing to update");

  const { data: client, error: updateErr } = await supabase
    .from("clients")
    .update(update)
    .eq("id", id)
    .select()
    .single();

  if (updateErr || !client) {
    if (updateErr?.code === "23505" || /duplicate key|unique/i.test(updateErr?.message ?? "")) {
      return conflict("slug_taken", { slug: d.slug });
    }
    return serverError(updateErr ?? "update failed");
  }

  await emitEvent(supabase, {
    kind: eventKind("client", "updated"),
    refTable: "clients",
    refId: client.id,
    payload: { fields: Object.keys(update) } as Json,
  });

  return ok({ client });
}

/**
 * DELETE /api/clients/:id
 *
 * Soft-archive (set `deleted_at`). Compare-and-set: archiving an
 * already-archived client returns 409; a missing one 404. Emits
 * `client_archived`. The cascade children are intentionally NOT touched — the
 * client row is the tombstone and the detail/list views filter on it.
 */
export async function DELETE(_req: NextRequest, ctx: RouteContext) {
  const { id } = await ctx.params;
  const supabase = createAdminClient();

  const result = await softDelete<Client>(supabase, "clients", id);
  if (result.kind === "missing") return notFound();
  if (result.kind === "conflict") return conflict(result.reason);
  if (result.kind === "error") return serverError(result.message);

  await emitEvent(supabase, {
    kind: eventKind("client", "archived"),
    refTable: "clients",
    refId: id,
    payload: null,
  });

  return ok({ client: result.row });
}
