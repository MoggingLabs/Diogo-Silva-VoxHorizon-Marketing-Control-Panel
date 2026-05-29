import "server-only";

import {
  getDerivedStatus,
  hydratePipelineStatus,
  hydratePipelineStatusMany,
} from "@/lib/pipeline/derived-status";
import type { PipelineEventInsert, PipelineInsert } from "@/lib/pipeline/schemas";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/types.gen";
import type { Pipeline, PipelineEvent, PipelineFormat, PipelineStatus } from "@/lib/pipeline/types";

/**
 * Server-only data layer for the pipeline read/write paths the dashboard
 * Server Components depend on.
 *
 * These were previously reached by Server Components self-fetching their OWN
 * gated `/api/pipelines*` routes via `lib/pipeline/client.ts`. The single-
 * operator session gate (`middleware.ts`) 401s those server-to-server fetches
 * because the operator cookie is not forwarded, so the SSR render saw an empty
 * list / a detail error. The fix is to call this data layer directly from the
 * Server Components and keep the `/api/pipelines*` routes as thin HTTP wrappers
 * on top of the SAME functions for external (browser / worker) callers.
 *
 * The bodies below are lifted VERBATIM from the route handlers so behaviour is
 * preserved exactly; the only change is that they return data (and throw on DB
 * error) instead of building a `NextResponse`.
 */

/** Filters accepted by {@link listPipelinesQuery}; mirrors `ListPipelinesQuery`. */
export type ListPipelinesQueryFilters = {
  status?: PipelineStatus;
  client_id?: string;
  limit: number;
  cursor?: string;
  /** When true, list ONLY archived (soft-deleted) pipelines (#609). */
  archived?: boolean;
};

export type ListPipelinesResult = {
  pipelines: Pipeline[];
  next_cursor: string | null;
};

export type GetPipelineResult = {
  pipeline: Pipeline;
  image_brief: unknown;
  video_brief: unknown;
  events: PipelineEvent[];
};

/**
 * List pipelines newest-first. Mirrors `GET /api/pipelines`:
 *   - `status` filters via `v_pipeline_dispatch_state.derived_status` (the
 *     event-sourced replacement for the dropped `pipelines.status` column),
 *     intersected with the pipelines page.
 *   - `archived` toggles the soft-archive filter (default = active only).
 *   - `client_id` / `cursor` / `limit` narrow + paginate the page.
 *
 * Throws on a DB error.
 */
export async function listPipelinesQuery(
  filters: ListPipelinesQueryFilters,
): Promise<ListPipelinesResult> {
  const { status, client_id, limit, cursor, archived = false } = filters;

  const supabase = createAdminClient();
  // Silent-failure PR-4: `pipelines.status` was dropped (migration 0051). When
  // the caller filters by `status`, we read derived_status from
  // `v_pipeline_dispatch_state` and INTERSECT with the pipelines page below.
  // Otherwise we read the pipelines table directly and hydrate status per row.
  let filteredIds: Set<string> | null = null;
  if (status) {
    const { data: vRows, error: vErr } = await supabase
      .from("v_pipeline_dispatch_state")
      .select("pipeline_id, derived_status")
      .eq("derived_status", status);
    if (vErr) {
      throw new Error(vErr.message);
    }
    filteredIds = new Set(
      (vRows ?? []).map((r) => r.pipeline_id).filter((id): id is string => typeof id === "string"),
    );
    // No matches -- early return with an empty page.
    if (filteredIds.size === 0) {
      return { pipelines: [], next_cursor: null };
    }
  }

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

  if (filteredIds) {
    query = query.in("id", Array.from(filteredIds));
  }
  if (client_id) query = query.eq("client_id", client_id);
  if (cursor) query = query.lt("created_at", cursor);

  const { data, error } = await query;
  if (error) {
    throw new Error(error.message);
  }
  const rows = data ?? [];
  // Hydrate `status` per row from the reducer so the list page (and every API
  // client) sees the same Pipeline shape it did before the column was dropped.
  const enriched = await hydratePipelineStatusMany(supabase, rows);
  const next_cursor = rows.length === limit ? (rows[rows.length - 1]?.created_at ?? null) : null;
  return { pipelines: enriched as unknown as Pipeline[], next_cursor };
}

/**
 * Fetch a single pipeline plus its linked image/video brief(s) and the 50 most
 * recent timeline events (newest-first). Mirrors `GET /api/pipelines/:id`.
 *
 * Returns `null` when the pipeline row is missing (the route maps this to a
 * 404; the detail page maps it to `notFound()`). Throws on a DB error.
 */
export async function getPipelineQuery(id: string): Promise<GetPipelineResult | null> {
  const supabase = createAdminClient();

  const { data, error } = await supabase
    .from("pipelines")
    .select(
      `
        *,
        image_brief:briefs!pipelines_image_brief_id_fkey(*),
        video_brief:video_briefs!pipelines_video_brief_id_fkey(*),
        events:pipeline_events(*)
      `,
    )
    .eq("id", id)
    .order("created_at", {
      ascending: false,
      referencedTable: "pipeline_events",
    })
    .limit(50, { referencedTable: "pipeline_events" })
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }
  if (!data) {
    return null;
  }

  // Split the embedded shape into top-level keys for a cleaner client API.
  const {
    image_brief = null,
    video_brief = null,
    events = [],
    ...pipelineRow
  } = data as typeof data & {
    image_brief: unknown;
    video_brief: unknown;
    events: unknown[];
  };

  // Silent-failure PR-4: `pipelines.status` was dropped (migration 0051). The
  // curated `Pipeline` view-model still carries `status` (the UI's stepper +
  // badges + routing read it), so hydrate it from the event-sourced reducer
  // before returning. One RPC round-trip per detail-page render.
  const derived = await getDerivedStatus(supabase, id);
  const pipeline = { ...pipelineRow, status: derived ?? "configuration" } as unknown as Pipeline;

  return {
    pipeline,
    image_brief: image_brief ?? null,
    video_brief: video_brief ?? null,
    events: (events ?? []) as unknown as PipelineEvent[],
  };
}

/** Input to {@link createPipelineRecord}; mirrors `CreatePipelineInput`. */
export type CreatePipelineRecordInput = {
  format_choice: PipelineFormat;
  client_id?: string;
};

/**
 * Create a new pipeline row in the `configuration` stage and emit the initial
 * `stage_advanced` bootstrap event. Mirrors `POST /api/pipelines`:
 *   - Inserts the pipelines row (seeding `advanced_at.configuration`).
 *   - Inserts the bootstrap `pipeline_events` row. If that insert fails the
 *     pipeline row is still the primary artifact, so we log and continue rather
 *     than rolling back.
 *   - Hydrates `status` from the reducer before returning.
 *
 * Throws on the pipelines insert failure.
 */
export async function createPipelineRecord(input: CreatePipelineRecordInput): Promise<Pipeline> {
  const supabase = createAdminClient();
  const now = new Date().toISOString();
  const insert: PipelineInsert = {
    format_choice: input.format_choice,
    client_id: input.client_id ?? null,
    advanced_at: { configuration: now } as unknown as Json,
  };

  const { data: pipeline, error: insertErr } = await supabase
    .from("pipelines")
    .insert(insert)
    .select()
    .single();

  if (insertErr || !pipeline) {
    throw new Error(insertErr?.message ?? "insert failed");
  }

  const event: PipelineEventInsert = {
    pipeline_id: pipeline.id,
    kind: "stage_advanced",
    stage: "configuration",
    payload: {
      format_choice: input.format_choice,
      client_id: input.client_id ?? null,
    } as Json,
  };
  const { error: evErr } = await supabase.from("pipeline_events").insert(event);
  if (evErr) {
    // The pipeline row is the primary artifact -- don't fail the request.
    console.warn(`[pipelines.create] event insert failed: ${evErr.message}`);
  }

  // Silent-failure PR-4: hydrate `status` from the reducer (the seed
  // `stage_advanced` event we just inserted resolves to 'configuration').
  const enriched = await hydratePipelineStatus(supabase, pipeline);
  return enriched as unknown as Pipeline;
}
