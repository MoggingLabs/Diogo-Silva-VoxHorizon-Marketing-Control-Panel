import { NextResponse, type NextRequest } from "next/server";

import {
  CreatePipelineInput,
  ListPipelinesQuery,
  type PipelineEventInsert,
  type PipelineInsert,
} from "@/lib/pipeline/schemas";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/types.gen";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/pipelines
 *
 * Lists pipelines newest-first. Excludes archived (soft-deleted) rows by
 * default. Supports:
 *   - `?status=<pipeline_status_enum>` — filter by lifecycle stage.
 *   - `?client_id=<uuid>` — filter to one client.
 *   - `?archived=true` shows ONLY archived (`deleted_at is not null`) rows.
 *     Omitted / `false` returns only active (`deleted_at is null`) rows.
 *   - `?limit=<n>` — page size (default 50, max 200).
 *   - `?cursor=<iso8601>` — cursor for the next page; the next page is rows
 *     with `created_at < cursor`. The `next_cursor` in the response is the
 *     last item's `created_at`, ready to feed back into the next request.
 *     `null` when the current page is the last one.
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const queryRaw: Record<string, unknown> = {};
  for (const k of ["status", "client_id", "limit", "cursor"] as const) {
    const v = url.searchParams.get(k);
    if (v !== null) queryRaw[k] = v;
  }
  const parsed = ListPipelinesQuery.safeParse(queryRaw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation_failed", issues: parsed.error.issues },
      { status: 422 },
    );
  }
  const { status, client_id, limit, cursor } = parsed.data;

  // Archived view is an explicit opt-in (`?archived=true`). Anything else
  // (absent / "false" / "0") keeps the default active-only list.
  const archivedRaw = url.searchParams.get("archived");
  const archived = archivedRaw === "true" || archivedRaw === "1";

  const supabase = createAdminClient();
  let query = supabase
    .from("pipelines")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);

  // Soft-archive filter (migration 0048): default hides archived rows; the
  // archived view shows only them.
  if (archived) {
    query = query.not("deleted_at", "is", null);
  } else {
    query = query.is("deleted_at", null);
  }

  if (status) query = query.eq("status", status);
  if (client_id) query = query.eq("client_id", client_id);
  if (cursor) query = query.lt("created_at", cursor);

  const { data, error } = await query;
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  const rows = data ?? [];
  const next_cursor = rows.length === limit ? (rows[rows.length - 1]?.created_at ?? null) : null;
  return NextResponse.json({ pipelines: rows, next_cursor });
}

/**
 * POST /api/pipelines
 *
 * Creates a new pipeline row in the `configuration` stage and emits the
 * initial `pipeline_events(kind='stage_advanced', stage='configuration')`
 * timeline entry so the UI can render the timeline pane from row 1.
 *
 * Body: `{ format_choice: 'image'|'video'|'both', client_id?: uuid }`.
 *
 * Returns the created pipeline row with status 201.
 *
 * Side effects:
 *   1. Inserts the pipelines row (status defaults to `configuration` via
 *      the DB schema; we also seed `advanced_at.configuration`).
 *   2. Inserts the bootstrap pipeline_events row. If the event insert
 *      fails the pipeline row is still real — we log and continue rather
 *      than rolling back, because the row is the primary artifact.
 */
export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = CreatePipelineInput.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation_failed", issues: parsed.error.issues },
      { status: 422 },
    );
  }

  const supabase = createAdminClient();
  const now = new Date().toISOString();
  const insert: PipelineInsert = {
    format_choice: parsed.data.format_choice,
    client_id: parsed.data.client_id ?? null,
    advanced_at: { configuration: now } as unknown as Json,
  };

  const { data: pipeline, error: insertErr } = await supabase
    .from("pipelines")
    .insert(insert)
    .select()
    .single();

  if (insertErr || !pipeline) {
    return NextResponse.json({ error: insertErr?.message ?? "insert failed" }, { status: 500 });
  }

  const event: PipelineEventInsert = {
    pipeline_id: pipeline.id,
    kind: "stage_advanced",
    stage: "configuration",
    payload: {
      format_choice: parsed.data.format_choice,
      client_id: parsed.data.client_id ?? null,
    } as Json,
  };
  const { error: evErr } = await supabase.from("pipeline_events").insert(event);
  if (evErr) {
    // The pipeline row is the primary artifact — don't fail the request.
    console.warn(`[pipelines.create] event insert failed: ${evErr.message}`);
  }

  return NextResponse.json({ pipeline }, { status: 201 });
}
