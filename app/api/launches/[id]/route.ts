import { NextResponse, type NextRequest } from "next/server";

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
import {
  LaunchPackageUpdateInput,
  type LaunchPackage,
  type LaunchPackageUpdate,
} from "@/lib/launches";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * GET /api/launches/:id
 *
 * Read a single launch package with the associated brief reference.
 * Used by the detail page client refresh after a decision is recorded.
 */
export async function GET(_req: NextRequest, ctx: RouteContext) {
  const { id } = await ctx.params;

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("launch_packages")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ launch: data });
}

/**
 * PATCH /api/launches/:id
 *
 * Operator package edit (E5.1 / #595). Launch packages are SAFE artifacts, so
 * the operator can annotate them — but the launch DECISION still goes through
 * the decision route (which re-derives the gate), and the ad_entity graph is
 * worker/Meta-owned (read-only here). The editable surface is therefore the
 * free-form ``decided_notes`` only. Emits a non-fatal ``launch_package_updated``
 * audit event.
 */
export async function PATCH(req: NextRequest, ctx: RouteContext) {
  const { id } = await ctx.params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return badJson();
  }

  const parsed = LaunchPackageUpdateInput.safeParse(body);
  if (!parsed.success) return zodError(parsed.error);

  const supabase = createAdminClient();

  const update: LaunchPackageUpdate = parsed.data;
  const { data: launch, error: updateErr } = await supabase
    .from("launch_packages")
    .update(update)
    .eq("id", id)
    .is("deleted_at", null)
    .select()
    .maybeSingle();
  if (updateErr) return serverError(updateErr.message);
  if (!launch) return notFound();

  await emitEvent(supabase, {
    kind: eventKind("launch_package", "updated"),
    refTable: "launch_packages",
    refId: id,
    payload: parsed.data,
  });

  return ok({ launch });
}

/**
 * DELETE /api/launches/:id
 *
 * Soft-archive a launch package (E5.1 / #595). Launch packages carry a
 * ``deleted_at`` tombstone (migration 0047), so "delete = soft-delete" per the
 * makeover guardrail: the package drops out of the active list and is fully
 * restorable via the sibling ``/restore`` route. Compare-and-set: a
 * double-archive is 409; a missing row is 404. Emits a non-fatal
 * ``launch_package_archived`` audit event.
 */
export async function DELETE(_req: NextRequest, ctx: RouteContext) {
  const { id } = await ctx.params;
  const supabase = createAdminClient();

  const result = await softDelete<LaunchPackage>(supabase, "launch_packages", id);

  switch (result.kind) {
    case "ok":
      await emitEvent(supabase, {
        kind: eventKind("launch_package", "archived"),
        refTable: "launch_packages",
        refId: id,
        payload: { deleted_at: result.row.deleted_at },
      });
      return ok({ launch: result.row });
    case "missing":
      return notFound();
    case "conflict":
      return conflict(result.reason);
    case "error":
      return serverError(result.message);
  }
}
