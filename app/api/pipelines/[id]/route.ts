import { NextResponse, type NextRequest } from "next/server";

import { conflict, emitEvent, eventKind, notFound, ok, serverError, softDelete } from "@/lib/crud";
import { getPipelineQuery } from "@/lib/pipeline/queries";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Pipeline } from "@/lib/pipeline/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * GET /api/pipelines/:id
 *
 * Returns a single pipeline plus its linked image/video brief(s) and the
 * 50 most recent timeline events (newest-first). Pulled in one Supabase
 * round-trip via embedded resources, so the detail-page server component
 * has everything it needs without a fan-out.
 *
 * Returns 404 if the pipeline row is missing.
 *
 * Response shape:
 *   {
 *     pipeline:    Pipeline,
 *     image_brief: Brief | null,
 *     video_brief: VideoBrief | null,
 *     events:      PipelineEvent[],
 *   }
 *
 * Note: PostgREST embedded resources rely on the FK relationships declared
 * in `0006_pipelines.sql`. The aliased selection (`image_brief:briefs!...`)
 * unpacks each FK target into a flat named field rather than the default
 * `briefs[]` array, since each FK is many-to-one.
 *
 * Thin HTTP wrapper: delegates to `getPipelineQuery` (the shared data layer the
 * detail-page Server Component calls directly). A null result (missing row)
 * maps to 404; a thrown DB error maps to 500.
 */
export async function GET(_req: NextRequest, ctx: RouteContext) {
  const { id } = await ctx.params;

  try {
    const result = await getPipelineQuery(id);
    if (!result) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "fetch failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * DELETE /api/pipelines/:id
 *
 * Archive (soft-delete) a pipeline. A pipeline is the orchestration root
 * (`pipeline_events` cascade, `creatives.pipeline_id` set-null), so we never
 * hard-delete it -- that would destroy the run's timeline. Instead we set
 * `deleted_at = now()` (migration 0048) which hides the row from the active
 * list and is reversible via the sibling `/restore` route. This is the
 * makeover's "delete = soft-delete" guardrail.
 *
 * Compare-and-set: only a currently-active row (`deleted_at is null`) is
 * archived. A double-archive is reported as 409 (already archived); a missing
 * row is 404. On success we emit a `pipeline_archived` audit event (non-fatal)
 * and return the archived row.
 */
export async function DELETE(_req: NextRequest, ctx: RouteContext) {
  const { id } = await ctx.params;
  const supabase = createAdminClient();

  const result = await softDelete<Pipeline>(supabase, "pipelines", id);

  switch (result.kind) {
    case "ok":
      await emitEvent(supabase, {
        kind: eventKind("pipeline", "archived"),
        refTable: "pipelines",
        refId: id,
        payload: { deleted_at: result.row.deleted_at },
      });
      return ok({ pipeline: result.row });
    case "missing":
      return notFound();
    case "conflict":
      return conflict(result.reason);
    case "error":
      return serverError(result.message);
  }
}
