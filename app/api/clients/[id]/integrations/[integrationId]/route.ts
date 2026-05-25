import { type NextRequest } from "next/server";

import {
  badJson,
  conflict,
  emitEvent,
  eventKind,
  notFound,
  ok,
  serverError,
  softDelete,
  zodError,
} from "@/lib/crud";
import { maskIntegration } from "@/lib/clients/integrations";
import { UpdateIntegrationInput } from "@/lib/clients/schemas";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/types.gen";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string; integrationId: string }> };

/**
 * PATCH /api/clients/:id/integrations/:integrationId
 *
 * Edit an integration (provider / external_id / config / active). A provider
 * change that collides with an existing row returns 409. The updated row is
 * returned with secrets masked. Emits `client_integration_updated`.
 *
 * Note on `config`: a PATCH replaces the whole config object (it is not deep-
 * merged) because masking means the client never holds the full secret value to
 * round-trip; the operator re-enters the credentials when they edit config.
 */
export async function PATCH(req: NextRequest, ctx: RouteContext) {
  const { integrationId } = await ctx.params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return badJson();
  }

  const parsed = UpdateIntegrationInput.safeParse(body);
  if (!parsed.success) return zodError(parsed.error);

  const supabase = createAdminClient();

  const update: Record<string, unknown> = {};
  const d = parsed.data;
  if (d.provider !== undefined) update.provider = d.provider;
  if (d.external_id !== undefined) update.external_id = d.external_id;
  if (d.config !== undefined) update.config = (d.config ?? {}) as Json;
  if (d.active !== undefined) update.active = d.active;

  const { data: row, error } = await supabase
    .from("client_integrations")
    .update(update as never)
    .eq("id", integrationId)
    .is("deleted_at", null)
    .select()
    .maybeSingle();

  if (error) {
    if (error.code === "23505" || /duplicate key|unique/i.test(error.message ?? "")) {
      return conflict("provider_taken", { provider: d.provider });
    }
    return serverError(error);
  }
  if (!row) return notFound();

  await emitEvent(supabase, {
    kind: eventKind("client_integration", "updated"),
    refTable: "client_integrations",
    refId: integrationId,
    payload: { fields: Object.keys(update) } as Json,
  });

  return ok({ integration: maskIntegration(row) });
}

/**
 * DELETE /api/clients/:id/integrations/:integrationId
 *
 * Soft-archive the integration (compare-and-set). Emits
 * `client_integration_archived`. The returned row is masked.
 */
export async function DELETE(_req: NextRequest, ctx: RouteContext) {
  const { integrationId } = await ctx.params;
  const supabase = createAdminClient();

  const result = await softDelete<{ id: string; config: Json }>(
    supabase,
    "client_integrations",
    integrationId,
  );
  if (result.kind === "missing") return notFound();
  if (result.kind === "conflict") return conflict(result.reason);
  if (result.kind === "error") return serverError(result.message);

  await emitEvent(supabase, {
    kind: eventKind("client_integration", "archived"),
    refTable: "client_integrations",
    refId: integrationId,
    payload: null,
  });

  return ok({ integration: maskIntegration(result.row) });
}
