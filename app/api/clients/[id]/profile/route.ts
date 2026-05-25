import { type NextRequest } from "next/server";

import { badJson, emitEvent, eventKind, notFound, ok, serverError, zodError } from "@/lib/crud";
import { UpsertProfileInput, type ClientProfileInsert } from "@/lib/clients/schemas";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/types.gen";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * GET /api/clients/:id/profile
 *
 * Fetch the 1:1 client profile. Returns `{ profile: null }` (200) when the
 * client has no profile row yet rather than 404, so the detail page can render
 * an empty editable form.
 */
export async function GET(_req: NextRequest, ctx: RouteContext) {
  const { id } = await ctx.params;
  const supabase = createAdminClient();

  const { data, error } = await supabase
    .from("client_profiles")
    .select("*")
    .eq("client_id", id)
    .is("deleted_at", null)
    .maybeSingle();

  if (error) return serverError(error);
  return ok({ profile: data ?? null });
}

/**
 * PUT /api/clients/:id/profile
 *
 * Upsert the 1:1 profile (client_profiles PK is client_id). Validates the body,
 * injects client_id from the path, and upserts. Emits `client_profile_updated`.
 * A bad client id surfaces as 404 (the FK target check) rather than a raw 500.
 */
export async function PUT(req: NextRequest, ctx: RouteContext) {
  const { id } = await ctx.params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return badJson();
  }

  const parsed = UpsertProfileInput.safeParse(body);
  if (!parsed.success) return zodError(parsed.error);

  const supabase = createAdminClient();

  const { data: client, error: clientErr } = await supabase
    .from("clients")
    .select("id")
    .eq("id", id)
    .maybeSingle();
  if (clientErr) return serverError(clientErr);
  if (!client) return notFound("client_not_found");

  const upsert: ClientProfileInsert = {
    ...(parsed.data as Record<string, unknown>),
    client_id: id,
    // Clear the tombstone on upsert so re-saving a previously-archived profile
    // brings it back live.
    deleted_at: null,
  } as ClientProfileInsert;

  const { data: profile, error } = await supabase
    .from("client_profiles")
    .upsert(upsert, { onConflict: "client_id" })
    .select()
    .single();

  if (error || !profile) return serverError(error ?? "upsert failed");

  await emitEvent(supabase, {
    kind: eventKind("client_profile", "updated"),
    refTable: "client_profiles",
    refId: id,
    payload: { fields: Object.keys(parsed.data as object) } as Json,
  });

  return ok({ profile });
}
