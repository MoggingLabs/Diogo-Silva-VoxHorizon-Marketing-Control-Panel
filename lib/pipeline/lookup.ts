import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Brief → pipeline reverse lookup. Used by the dashboard to decide whether a
 * Kanban card's deep link should jump into the Pipeline detail view (when a
 * pipeline owns the brief) or fall back to the standalone brief page.
 *
 * The dashboard render is a hot path: we MUST avoid an N+1 fan-out (one
 * Supabase query per card). `findPipelinesForBriefs` accepts both brief-id
 * arrays at once and issues a single OR'd query against `pipelines`,
 * returning two maps keyed by brief id.
 *
 * Briefs created via the standalone form have no pipeline (and so are absent
 * from the map). Briefs created via the Pipeline have exactly one pipeline
 * pointing back at them (`pipelines.image_brief_id` / `video_brief_id`).
 * If multiple pipelines ever point at the same brief (shouldn't happen in
 * v1, but the schema doesn't enforce uniqueness), the most-recently-created
 * pipeline wins — the operator's "latest run" intent.
 */
export type PipelineForBriefsResult = {
  image: Map<string, string>;
  video: Map<string, string>;
};

/**
 * Resolve the pipeline id (if any) for each brief in the input arrays.
 *
 * Empty input arrays short-circuit to an empty result without hitting the
 * DB. Single round-trip otherwise.
 *
 * Returns Maps so callers can do `image.get(briefId)` with O(1) lookup; the
 * value is the pipeline id (uuid string) or `undefined` for "no pipeline".
 */
export async function findPipelinesForBriefs(
  imageBriefIds: string[],
  videoBriefIds: string[],
): Promise<PipelineForBriefsResult> {
  const image = new Map<string, string>();
  const video = new Map<string, string>();

  // Deduplicate up-front: the dashboard may pass the same brief id twice
  // (extremely rare, but cheap insurance).
  const imageSet = new Set(imageBriefIds);
  const videoSet = new Set(videoBriefIds);

  if (imageSet.size === 0 && videoSet.size === 0) {
    return { image, video };
  }

  const supabase = createAdminClient();

  // Single query with an OR across the two FK columns. PostgREST's `or`
  // filter takes a comma-separated list of `<col>.<op>.<value>` clauses;
  // `in` takes a parenthesized list. Either array can be empty, in which
  // case we omit the clause to avoid a syntax-error `in.()`.
  const orClauses: string[] = [];
  if (imageSet.size > 0) {
    orClauses.push(`image_brief_id.in.(${Array.from(imageSet).join(",")})`);
  }
  if (videoSet.size > 0) {
    orClauses.push(`video_brief_id.in.(${Array.from(videoSet).join(",")})`);
  }

  const { data, error } = await supabase
    .from("pipelines")
    .select("id, image_brief_id, video_brief_id, created_at")
    .or(orClauses.join(","))
    // Order ASC so a later (more recent) row overwrites earlier ones during
    // the Map fill — the operator's most-recent pipeline wins.
    .order("created_at", { ascending: true });

  if (error) {
    // Soft-fail: don't break dashboard rendering on a lookup miss; just log
    // and return empty maps so cards fall back to the standalone brief link.
    console.warn(`[pipeline.lookup] findPipelinesForBriefs failed: ${error.message}`);
    return { image, video };
  }

  for (const row of data ?? []) {
    if (row.image_brief_id && imageSet.has(row.image_brief_id)) {
      image.set(row.image_brief_id, row.id);
    }
    if (row.video_brief_id && videoSet.has(row.video_brief_id)) {
      video.set(row.video_brief_id, row.id);
    }
  }

  return { image, video };
}
