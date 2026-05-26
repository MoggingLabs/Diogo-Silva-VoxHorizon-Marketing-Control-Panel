import { type NextRequest } from "next/server";

import { conflict, emitEvent, eventKind, notFound, ok, restore, serverError } from "@/lib/crud";
import { type Client } from "@/lib/clients/schemas";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * POST /api/clients/:id/restore
 *
 * Clear the `deleted_at` tombstone. Compare-and-set: restoring a live client
 * returns 409 (`not_archived`); a missing one 404. Emits `client_restored`.
 */
export async function POST(_req: NextRequest, ctx: RouteContext) {
  const { id } = await ctx.params;
  const supabase = createAdminClient();

  const result = await restore<Client>(supabase, "clients", id);
  if (result.kind === "missing") return notFound();
  if (result.kind === "conflict") return conflict(result.reason);
  if (result.kind === "error") return serverError(result.message);

  await emitEvent(supabase, {
    kind: eventKind("client", "restored"),
    refTable: "clients",
    refId: id,
    payload: null,
  });

  return ok({ client: result.row });
}
