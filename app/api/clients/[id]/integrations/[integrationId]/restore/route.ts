import { type NextRequest } from "next/server";

import { conflict, emitEvent, eventKind, notFound, ok, restore, serverError } from "@/lib/crud";
import { maskIntegration } from "@/lib/clients/integrations";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/types.gen";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string; integrationId: string }> };

/**
 * POST /api/clients/:id/integrations/:integrationId/restore
 *
 * Clear the integration tombstone (compare-and-set). Emits
 * `client_integration_restored`. The returned row is masked.
 */
export async function POST(_req: NextRequest, ctx: RouteContext) {
  const { integrationId } = await ctx.params;
  const supabase = createAdminClient();

  const result = await restore<{ id: string; config: Json }>(
    supabase,
    "client_integrations",
    integrationId,
  );
  if (result.kind === "missing") return notFound();
  if (result.kind === "conflict") return conflict(result.reason);
  if (result.kind === "error") return serverError(result.message);

  await emitEvent(supabase, {
    kind: eventKind("client_integration", "restored"),
    refTable: "client_integrations",
    refId: integrationId,
    payload: null,
  });

  return ok({ integration: maskIntegration(result.row) });
}
