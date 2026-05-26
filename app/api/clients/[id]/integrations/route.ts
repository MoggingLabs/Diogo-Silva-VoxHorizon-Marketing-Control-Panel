import { type NextRequest } from "next/server";

import {
  badJson,
  conflict,
  created,
  emitEvent,
  eventKind,
  notFound,
  ok,
  serverError,
  zodError,
} from "@/lib/crud";
import { maskIntegration, maskIntegrations } from "@/lib/clients/integrations";
import { CreateIntegrationInput } from "@/lib/clients/schemas";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/types.gen";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * GET /api/clients/:id/integrations
 *
 * List a client's integrations (active tombstone only). Secrets in each row's
 * `config` jsonb are MASKED before returning (E2.3 guardrail). Ordered by
 * provider for a stable UI.
 */
export async function GET(_req: NextRequest, ctx: RouteContext) {
  const { id } = await ctx.params;
  const supabase = createAdminClient();

  const { data, error } = await supabase
    .from("client_integrations")
    .select("*")
    .eq("client_id", id)
    .is("deleted_at", null)
    .order("provider", { ascending: true });

  if (error) return serverError(error);
  return ok({ integrations: maskIntegrations(data ?? []) });
}

/**
 * POST /api/clients/:id/integrations
 *
 * Create an integration. The DB enforces a unique (client_id, provider), so a
 * second integration for the same provider returns 409. The created row is
 * returned with secrets masked. Emits `client_integration_created`.
 */
export async function POST(req: NextRequest, ctx: RouteContext) {
  const { id } = await ctx.params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return badJson();
  }

  const parsed = CreateIntegrationInput.safeParse(body);
  if (!parsed.success) return zodError(parsed.error);

  const supabase = createAdminClient();

  const { data: client, error: clientErr } = await supabase
    .from("clients")
    .select("id")
    .eq("id", id)
    .maybeSingle();
  if (clientErr) return serverError(clientErr);
  if (!client) return notFound("client_not_found");

  const insert = {
    client_id: id,
    provider: parsed.data.provider,
    external_id: parsed.data.external_id ?? null,
    config: (parsed.data.config ?? {}) as Json,
    active: parsed.data.active ?? true,
  };

  const { data: row, error } = await supabase
    .from("client_integrations")
    .insert(insert)
    .select()
    .single();

  if (error || !row) {
    if (error?.code === "23505" || /duplicate key|unique/i.test(error?.message ?? "")) {
      return conflict("provider_taken", { provider: parsed.data.provider });
    }
    return serverError(error ?? "insert failed");
  }

  await emitEvent(supabase, {
    kind: eventKind("client_integration", "created"),
    refTable: "client_integrations",
    refId: row.id,
    payload: { client_id: id, provider: row.provider } as Json,
  });

  return created({ integration: maskIntegration(row) });
}
