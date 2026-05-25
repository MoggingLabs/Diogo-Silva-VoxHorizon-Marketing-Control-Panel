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
import { UpdateCreativeInput, type Creative, type CreativeUpdate } from "@/lib/creatives";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/types.gen";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * GET /api/creatives/:id
 *
 * Single image-creative fetch for the manage surface (M4 / #594). Returns the
 * creative row, its brief header (human id + status), the copy variants tied to
 * the creative, and the most recent `events` timeline rows about it — in one
 * round-trip so the manage page renders without a fan-out.
 *
 * Returns 404 if the creative row is missing.
 *
 * Response shape:
 *   {
 *     creative: Creative,
 *     brief: { id, brief_id_human, status, client_id } | null,
 *     copy_variants: CopyVariant[],
 *     qa: QaResult[],           // append-only, read-only here
 *     spec: SpecCheck[],        // override-route only, read-only here
 *     compliance: ComplianceFinding[], // override-route only, read-only here
 *     stage_state: CreativeStageState[], // gate state, read-only here
 *     events: Event[],
 *   }
 *
 * The gate artifacts (qa / spec / compliance / stage_state) are surfaced
 * READ-ONLY: per the guardrails they mutate only through their decision /
 * override routes (which are pipeline-scoped). The manage UI links back to the
 * pipeline review surface for those actions rather than duplicating them.
 */
export async function GET(_req: NextRequest, ctx: RouteContext) {
  const { id } = await ctx.params;
  const supabase = createAdminClient();

  const { data: creative, error } = await supabase
    .from("creatives")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (error) return serverError(error);
  if (!creative) return notFound();

  const [briefRes, copyRes, qaRes, specRes, complianceRes, stageRes, eventsRes] = await Promise.all(
    [
      supabase
        .from("briefs")
        .select("id, brief_id_human, status, client_id")
        .eq("id", creative.brief_id)
        .maybeSingle(),
      supabase
        .from("copy_variants")
        .select("*")
        .eq("creative_id", id)
        .order("created_at", { ascending: true })
        .limit(200),
      supabase
        .from("qa_result")
        .select("*")
        .eq("creative_id", id)
        .order("attempt", { ascending: false })
        .limit(20),
      supabase.from("spec_check").select("*").eq("creative_id", id).limit(50),
      supabase.from("compliance_finding").select("*").eq("creative_id", id).limit(100),
      supabase.from("creative_stage_state").select("*").eq("creative_id", id).limit(50),
      supabase
        .from("events")
        .select("id, kind, payload, created_at, ref_table, ref_id")
        .eq("ref_table", "creatives")
        .eq("ref_id", id)
        .order("created_at", { ascending: false })
        .limit(50),
    ],
  );

  if (briefRes.error) return serverError(briefRes.error);
  if (copyRes.error) return serverError(copyRes.error);
  if (qaRes.error) return serverError(qaRes.error);
  if (specRes.error) return serverError(specRes.error);
  if (complianceRes.error) return serverError(complianceRes.error);
  if (stageRes.error) return serverError(stageRes.error);
  if (eventsRes.error) return serverError(eventsRes.error);

  return ok({
    creative,
    brief: briefRes.data ?? null,
    copy_variants: copyRes.data ?? [],
    qa: qaRes.data ?? [],
    spec: specRes.data ?? [],
    compliance: complianceRes.data ?? [],
    stage_state: stageRes.data ?? [],
    events: eventsRes.data ?? [],
  });
}

/**
 * PATCH /api/creatives/:id
 *
 * Edit the operator-safe descriptive metadata of an image creative (concept,
 * offer text, asset name, ratio). Validated by `UpdateCreativeInput`.
 *
 * Guardrail: this route NEVER touches `status` — creative status transitions
 * flow through `POST /api/creatives/:id/decision` (the state machine). It also
 * never touches the worker-owned render columns or the FK lineage. An empty
 * patch (no recognised editable key) is rejected 400.
 *
 * Emits a non-fatal `creative_updated` audit event on success.
 */
export async function PATCH(req: NextRequest, ctx: RouteContext) {
  const { id } = await ctx.params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return badJson();
  }

  const parsed = UpdateCreativeInput.safeParse(body);
  if (!parsed.success) return zodError(parsed.error);

  // Only keep the keys actually present so we never overwrite a column with
  // undefined and so an empty patch is detectable.
  const update: CreativeUpdate = {};
  for (const key of ["concept", "offer_text", "asset_name", "ratio"] as const) {
    if (key in parsed.data && parsed.data[key] !== undefined) {
      (update as Record<string, unknown>)[key] = parsed.data[key];
    }
  }

  if (Object.keys(update).length === 0) {
    return badRequest("nothing to update");
  }

  const supabase = createAdminClient();

  const { data: creative, error } = await supabase
    .from("creatives")
    .update(update)
    .eq("id", id)
    .is("deleted_at", null)
    .select()
    .maybeSingle();

  if (error) return serverError(error);
  if (!creative) return notFound();

  await emitEvent(supabase, {
    kind: eventKind("creative", "updated"),
    refTable: "creatives",
    refId: id,
    payload: { fields: Object.keys(update) } as Json,
  });

  return ok({ creative: creative as Creative });
}

/**
 * DELETE /api/creatives/:id
 *
 * Archive (soft-delete) an image creative: sets `deleted_at = now()` (the
 * neutral creative base, migration 0034/0035) so it drops out of the active
 * grid but stays restorable via the sibling `/restore` route. This is the
 * makeover's "delete = soft-delete" guardrail — a creative is the root of copy
 * + launch lineage, so it is never hard-deleted.
 *
 * Compare-and-set: only a currently-active row is archived; a double-archive is
 * 409, a missing row is 404. Emits a non-fatal `creative_archived` event.
 */
export async function DELETE(_req: NextRequest, ctx: RouteContext) {
  const { id } = await ctx.params;
  const supabase = createAdminClient();

  const result = await softDelete<Creative>(supabase, "creatives", id);

  switch (result.kind) {
    case "ok":
      await emitEvent(supabase, {
        kind: eventKind("creative", "archived"),
        refTable: "creatives",
        refId: id,
        payload: { deleted_at: result.row.deleted_at },
      });
      return ok({ creative: result.row });
    case "missing":
      return notFound();
    case "conflict":
      return conflict(result.reason);
    case "error":
      return serverError(result.message);
  }
}
