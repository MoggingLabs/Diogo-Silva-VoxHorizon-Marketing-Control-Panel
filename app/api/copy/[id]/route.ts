import { NextResponse, type NextRequest } from "next/server";

import { conflict, emitEvent, eventKind, notFound, ok, serverError, softDelete } from "@/lib/crud";
import {
  CopyFormat,
  UpdateStandaloneCopyInput,
  copyTableFor,
  type CopyVariant,
  type CopyVariantUpdate,
  type VideoCopyVariant,
  type VideoCopyVariantUpdate,
} from "@/lib/copy/schemas";
import { buildCopyValidation } from "@/lib/copy/validation";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/types.gen";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * PATCH /api/copy/:id
 *
 * Edit one standalone copy variant. The body must carry `format` (image|video)
 * to select the table. Every content field is optional. **Editing re-arms
 * compliance** (the M3 guardrail + the existing pipeline rule): regardless of
 * what changed, the variant is reset to `draft` and its image-only approval
 * stamps are cleared, so it must be re-approved + re-screened before launch.
 * The `validation` jsonb is recomputed. Emits a `*_updated` audit event.
 */
export async function PATCH(req: NextRequest, ctx: RouteContext) {
  const { id } = await ctx.params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = UpdateStandaloneCopyInput.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation_failed", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const input = parsed.data;
  const supabase = createAdminClient();
  const table = copyTableFor(input.format);

  // Read the current row so the validation recompute sees the merged content
  // (a field the operator did not touch keeps its stored value) and so we can
  // 404 cleanly on a missing / wrong-format id.
  const { data: current, error: readErr } = await supabase
    .from(table)
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (readErr) return NextResponse.json({ error: readErr.message }, { status: 500 });
  if (!current) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const cur = current as CopyVariant | VideoCopyVariant;
  const merged = {
    platform: input.platform ?? cur.platform,
    placement: input.placement ?? cur.placement ?? undefined,
    headline: input.headline ?? cur.headline ?? undefined,
    body: input.body ?? cur.body ?? undefined,
    description: input.description ?? cur.description ?? undefined,
  };
  const validation = buildCopyValidation({
    platform: merged.platform,
    placement: merged.placement,
    headline: merged.headline,
    body: merged.body,
    description: merged.description,
  });

  const now = new Date().toISOString();

  if (input.format === "image") {
    const update: CopyVariantUpdate = {
      // Editing re-arms compliance: reset to draft + clear the approval stamps.
      status: "draft",
      approved_by: null,
      approved_at: null,
      decided_notes: null,
      validation: validation as unknown as Json,
      updated_at: now,
    };
    if (input.platform !== undefined) update.platform = input.platform;
    if (input.placement !== undefined) update.placement = input.placement;
    if (input.variant_index !== undefined) update.variant_index = input.variant_index;
    if (input.headline !== undefined) update.headline = input.headline;
    if (input.body !== undefined) update.body = input.body;
    if (input.description !== undefined) update.description = input.description;
    if (input.cta !== undefined) update.cta = input.cta;
    if (input.pattern !== undefined) update.pattern = input.pattern;
    if (input.humanized !== undefined) {
      update.humanized = input.humanized;
      update.humanized_at = input.humanized ? now : null;
    }

    const { data, error } = await supabase
      .from("copy_variants")
      .update(update)
      .eq("id", id)
      .select()
      .single();
    if (error || !data) return mapUpdateError(error?.message, error?.code);
    await emitEvent(supabase, {
      kind: "copy_variant_updated",
      refTable: "copy_variants",
      refId: id,
      payload: { recompliance: true } as Json,
    });
    return NextResponse.json({ variant: data });
  }

  // video: no approval-stamp columns to clear; reset status + recompute only.
  const update: VideoCopyVariantUpdate = {
    status: "draft",
    validation: validation as unknown as Json,
    updated_at: now,
  };
  if (input.platform !== undefined) update.platform = input.platform;
  if (input.placement !== undefined) update.placement = input.placement;
  if (input.variant_index !== undefined) update.variant_index = input.variant_index;
  if (input.headline !== undefined) update.headline = input.headline;
  if (input.body !== undefined) update.body = input.body;
  if (input.description !== undefined) update.description = input.description;
  if (input.cta !== undefined) update.cta = input.cta;
  if (input.pattern !== undefined) update.pattern = input.pattern;
  if (input.humanized !== undefined) update.humanized = input.humanized;

  const { data, error } = await supabase
    .from("video_copy_variants")
    .update(update)
    .eq("id", id)
    .select()
    .single();
  if (error || !data) return mapUpdateError(error?.message, error?.code);
  await emitEvent(supabase, {
    kind: "video_copy_variant_updated",
    refTable: "video_copy_variants",
    refId: id,
    payload: { recompliance: true } as Json,
  });
  return NextResponse.json({ variant: data });
}

/**
 * DELETE /api/copy/:id?format=image|video
 *
 * Archive (soft-delete) a standalone copy variant. `format` selects the table.
 * Compare-and-set: only a live row is archived (409 if already archived, 404 if
 * missing). Emits a `*_archived` audit event.
 */
export async function DELETE(req: NextRequest, ctx: RouteContext) {
  const { id } = await ctx.params;
  const formatParam = new URL(req.url).searchParams.get("format") ?? "image";
  const fmt = CopyFormat.safeParse(formatParam);
  if (!fmt.success) {
    return NextResponse.json({ error: "format must be image or video" }, { status: 400 });
  }
  const table = copyTableFor(fmt.data);
  const resource = fmt.data === "video" ? "video_copy_variant" : "copy_variant";
  const supabase = createAdminClient();

  const result = await softDelete<CopyVariant | VideoCopyVariant>(supabase, table, id);
  switch (result.kind) {
    case "ok":
      await emitEvent(supabase, {
        kind: eventKind(resource, "archived"),
        refTable: table,
        refId: id,
        payload: null,
      });
      return ok({ variant: result.row });
    case "missing":
      return notFound();
    case "conflict":
      return conflict(result.reason);
    case "error":
      return serverError(result.message);
  }
}

function mapUpdateError(message: string | undefined, code: string | undefined): NextResponse {
  if (code === "23505") {
    return NextResponse.json(
      { error: "duplicate_variant", detail: "that platform + variant index already exists" },
      { status: 409 },
    );
  }
  return NextResponse.json({ error: message ?? "copy update failed" }, { status: 500 });
}
