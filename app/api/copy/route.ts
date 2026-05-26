import { NextResponse, type NextRequest } from "next/server";

import { emitEvent } from "@/lib/crud";
import {
  CreateStandaloneCopyInput,
  copyTableFor,
  type CopyVariantInsert,
  type VideoCopyVariantInsert,
} from "@/lib/copy/schemas";
import { buildCopyValidation } from "@/lib/copy/validation";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/types.gen";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/copy?creative_id=<uuid>&format=image|video
 *
 * List the copy variants for a creative, outside the pipeline copy stage
 * (E3.3 / #592). `format` selects the table (`copy_variants` for image,
 * `video_copy_variants` for video). Active rows only by default; `?archived=1`
 * lists archived, `?archived=all` includes both. Ordered by variant_index.
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const creativeId = url.searchParams.get("creative_id");
  const formatParam = url.searchParams.get("format") ?? "image";
  const archived = url.searchParams.get("archived");

  if (!creativeId) {
    return NextResponse.json({ error: "creative_id is required" }, { status: 400 });
  }
  if (formatParam !== "image" && formatParam !== "video") {
    return NextResponse.json({ error: "format must be image or video" }, { status: 400 });
  }

  const supabase = createAdminClient();
  const table = copyTableFor(formatParam);

  let query = supabase
    .from(table)
    .select("*")
    .eq("creative_id", creativeId)
    .order("variant_index", { ascending: true })
    .limit(200);

  if (archived === "1" || archived === "true") {
    query = query.not("deleted_at", "is", null);
  } else if (archived !== "all") {
    query = query.is("deleted_at", null);
  }

  const { data, error } = await query;
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ variants: data ?? [] });
}

/**
 * POST /api/copy
 *
 * Create one standalone copy variant for a creative. `format` selects the
 * table; the row is keyed by (creative_id, platform, variant_index) so a
 * collision returns 409. The row starts in `draft` (a fresh variant must be
 * approved + compliance-screened before launch — same rule as the pipeline
 * path). `pipeline_id` is left null (this is an out-of-pipeline write). Emits a
 * `copy_variant_created` / `video_copy_variant_created` audit event.
 */
export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = CreateStandaloneCopyInput.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation_failed", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const input = parsed.data;
  const supabase = createAdminClient();

  const validation = buildCopyValidation(input);
  const now = new Date().toISOString();

  if (input.format === "image") {
    const insert: CopyVariantInsert = {
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
      status: "draft",
      updated_at: now,
    };
    const { data, error } = await supabase.from("copy_variants").insert(insert).select().single();
    if (error || !data) {
      return mapInsertError(error?.message, error?.code);
    }
    await emitEvent(supabase, {
      kind: "copy_variant_created",
      refTable: "copy_variants",
      refId: data.id,
      payload: { creative_id: input.creative_id, variant_index: input.variant_index } as Json,
    });
    return NextResponse.json({ variant: data }, { status: 201 });
  }

  // video: video_copy_variants lacks author / humanized_at columns.
  const insert: VideoCopyVariantInsert = {
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
    validation: validation as unknown as Json,
    status: "draft",
    updated_at: now,
  };
  const { data, error } = await supabase
    .from("video_copy_variants")
    .insert(insert)
    .select()
    .single();
  if (error || !data) {
    return mapInsertError(error?.message, error?.code);
  }
  await emitEvent(supabase, {
    kind: "video_copy_variant_created",
    refTable: "video_copy_variants",
    refId: data.id,
    payload: { creative_id: input.creative_id, variant_index: input.variant_index } as Json,
  });
  return NextResponse.json({ variant: data }, { status: 201 });
}

/**
 * Map a Postgres insert error to the right HTTP status: a unique-violation on
 * the (creative_id, platform, variant_index) index is a 409 (that variant slot
 * is taken), everything else a 500.
 */
function mapInsertError(message: string | undefined, code: string | undefined): NextResponse {
  if (code === "23505") {
    return NextResponse.json(
      { error: "duplicate_variant", detail: "that platform + variant index already exists" },
      { status: 409 },
    );
  }
  return NextResponse.json({ error: message ?? "copy insert failed" }, { status: 500 });
}
