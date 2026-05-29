import { NextResponse, type NextRequest } from "next/server";

import { createPipelineRecord, listPipelinesQuery } from "@/lib/pipeline/queries";
import { CreatePipelineInput, ListPipelinesQuery } from "@/lib/pipeline/schemas";

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
 *
 * Thin HTTP wrapper: parses + validates the query string, then delegates to
 * `listPipelinesQuery` (the shared data layer the Server Components call
 * directly). Server Components no longer self-fetch this route.
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

  try {
    const result = await listPipelinesQuery({ status, client_id, limit, cursor, archived });
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "list failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
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
 * Thin HTTP wrapper: parses the body + validates it, then delegates to
 * `createPipelineRecord` (the shared data layer the Server Component calls
 * directly). The command seeds `advanced_at.configuration`, inserts the
 * bootstrap event (non-fatal on failure), and hydrates `status`.
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

  try {
    const pipeline = await createPipelineRecord({
      format_choice: parsed.data.format_choice,
      client_id: parsed.data.client_id,
    });
    return NextResponse.json({ pipeline }, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "insert failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
