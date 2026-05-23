import { NextResponse, type NextRequest } from "next/server";

import {
  countWithStatus,
  type CopyField,
  type CopyPlatform,
  type CopyPlacement,
} from "@/lib/copy/platform-limits";
import {
  UpsertCopyInput,
  type CopyVariantInsert,
  type CopyVariantUpdate,
  type UpsertCopyInputT,
} from "@/lib/copy/schemas";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/types.gen";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * POST /api/pipelines/:id/copy
 *
 * Upsert one copy variant for a creative in the copy stage (#359, P4.4). The
 * row is keyed by (creative_id, platform, variant_index); a re-POST edits in
 * place. The route:
 *   - validates the body (zod),
 *   - guards the pipeline is in the `copy` stage (409 otherwise),
 *   - computes the per-field char-count validation against the platform limits
 *     and stores it in `copy_variants.validation` (shared by the editor +
 *     launch validator),
 *   - status starts at `draft`; **editing re-arms compliance** so an existing
 *     `approved` row is reset to `draft` on edit (void-on-content-change).
 *
 * Returns the upserted variant. Author is stamped `operator`.
 */
export async function POST(req: NextRequest, ctx: RouteContext) {
  const { id } = await ctx.params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = UpsertCopyInput.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation_failed", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const input = parsed.data;

  const supabase = createAdminClient();

  // Pipeline status guard.
  const { data: pipeline, error: readErr } = await supabase
    .from("pipelines")
    .select("id, status")
    .eq("id", id)
    .maybeSingle();
  if (readErr) {
    return NextResponse.json({ error: readErr.message }, { status: 500 });
  }
  if (!pipeline) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  if (pipeline.status !== "copy") {
    return NextResponse.json(
      { error: "invalid_state", current: pipeline.status, expected: "copy" },
      { status: 409 },
    );
  }

  // Per-field char-count validation against the destination platform limits.
  const validation = buildValidation(input);

  const now = new Date().toISOString();
  const common = {
    pipeline_id: id,
    creative_id: input.creative_id,
    platform: input.platform,
    placement: input.placement ?? null,
    variant_index: input.variant_index,
    headline: input.headline ?? null,
    body: input.body ?? null,
    description: input.description ?? null,
    cta: input.cta ?? null,
    pattern: input.pattern ?? null,
    humanized: input.humanized ?? false,
    humanized_at: input.humanized ? now : null,
    validation: validation as unknown as Json,
    author: "operator",
    // Editing copy re-arms compliance: a content change resets the variant to
    // draft (it must be re-approved + re-screened).
    status: "draft" as const,
    updated_at: now,
  };

  if (input.id) {
    const update: CopyVariantUpdate = common;
    const { data: updated, error: updateErr } = await supabase
      .from("copy_variants")
      .update(update)
      .eq("id", input.id)
      .eq("pipeline_id", id)
      .select()
      .single();
    if (updateErr || !updated) {
      return NextResponse.json(
        { error: updateErr?.message ?? "copy update failed" },
        { status: 500 },
      );
    }
    return NextResponse.json({ variant: updated });
  }

  const insert: CopyVariantInsert = common;
  const { data: inserted, error: insertErr } = await supabase
    .from("copy_variants")
    .insert(insert)
    .select()
    .single();
  if (insertErr || !inserted) {
    return NextResponse.json(
      { error: insertErr?.message ?? "copy insert failed" },
      { status: 500 },
    );
  }
  return NextResponse.json({ variant: inserted }, { status: 201 });
}

/**
 * Build the `validation` jsonb: per-field char-count status against the
 * platform's published limits. Stored so the launch validator can re-read it
 * without recomputing.
 */
const LIMITED_PLATFORMS: ReadonlySet<string> = new Set(["meta", "google"]);
const LIMITED_PLACEMENTS: ReadonlySet<string> = new Set([
  "feed",
  "stories",
  "reels",
  "rsa",
  "pmax",
]);

function buildValidation(input: UpsertCopyInputT): Record<string, unknown> {
  // Char limits are published for meta/google only (lib/copy/platform-limits).
  // For other platforms (e.g. tiktok) we record the lengths without a cap.
  if (!LIMITED_PLATFORMS.has(input.platform)) {
    const result: Record<string, unknown> = { ok: true };
    if (input.headline !== undefined) result.headline = { len: [...input.headline].length };
    if (input.body !== undefined) result.primary_text = { len: [...input.body].length };
    if (input.description !== undefined)
      result.description = { len: [...input.description].length };
    return result;
  }

  const platform = input.platform as CopyPlatform;
  const placement =
    input.placement && LIMITED_PLACEMENTS.has(input.placement)
      ? (input.placement as CopyPlacement)
      : undefined;

  const fields: Array<[CopyField, string | undefined]> = [
    ["headline", input.headline],
    ["primary_text", input.body],
    ["description", input.description],
  ];
  const result: Record<string, unknown> = {};
  let ok = true;
  for (const [field, value] of fields) {
    if (value === undefined) continue;
    const r = countWithStatus(value, field, platform, placement);
    result[field] = {
      len: r.len,
      max: Number.isFinite(r.max) ? r.max : null,
      status: r.status,
      over: r.over,
    };
    if (r.status === "error") ok = false;
  }
  result.ok = ok;
  return result;
}
