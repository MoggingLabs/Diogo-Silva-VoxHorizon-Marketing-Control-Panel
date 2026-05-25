import { NextResponse, type NextRequest } from "next/server";

import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/search?q=<text>  (E1.3 / #585)
 *
 * The cmd-k command-palette aggregator. One read-only, admin-client query fan-out
 * across the operator-facing artifacts:
 *
 *   - clients                              (name / slug, or exact id)
 *   - briefs + video_briefs                (brief_id_human, or exact id)
 *   - creatives + video_creatives          (concept / asset_name, or exact id)
 *   - launch_packages + video_launch_packages (status, or exact id)
 *   - pipelines                            (exact id)
 *
 * Returns a small, typed, capped result list `{ kind, id, label, href }` the
 * palette renders directly. Soft-deleted rows (`deleted_at is not null`) are
 * excluded everywhere the tombstone exists. Read-only: no writes, no events.
 *
 * Search semantics:
 *   - Free text matches the human-readable text columns with case-insensitive
 *     substring (`ilike`).
 *   - A query that is a full UUID additionally matches rows by exact `id` across
 *     every kind (so pasting an id from a URL resolves). Partial-uuid `ilike`
 *     is intentionally NOT attempted (uuid columns are not text).
 */

/** Per-kind row cap so one noisy kind cannot crowd out the others. */
const PER_KIND_LIMIT = 5;
/** Overall cap on the merged result list returned to the palette. */
const TOTAL_LIMIT = 25;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type SearchResultKind =
  | "client"
  | "brief"
  | "video_brief"
  | "creative"
  | "video_creative"
  | "launch_package"
  | "video_launch_package"
  | "pipeline";

export type SearchResult = {
  kind: SearchResultKind;
  id: string;
  label: string;
  href: string;
};

/** Escape a value for a PostgREST `or(...)` ilike term (commas / parens). */
function esc(value: string): string {
  return value.replace(/([(),])/g, "\\$1");
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const raw = url.searchParams.get("q");
  const q = raw?.trim() ?? "";

  // An empty query is a valid no-op for the palette (it shows nothing).
  if (q.length === 0) {
    return NextResponse.json({ results: [] satisfies SearchResult[] });
  }

  const supabase = createAdminClient();
  const like = `%${esc(q)}%`;
  const isUuid = UUID_RE.test(q);

  // Each task resolves to a typed result slice; run them concurrently.
  const tasks: Array<Promise<SearchResult[]>> = [];

  // --- clients -------------------------------------------------------------
  tasks.push(
    (async () => {
      let query = supabase
        .from("clients")
        .select("id, name, slug")
        .is("deleted_at", null)
        .limit(PER_KIND_LIMIT);
      query = isUuid
        ? query.or(`name.ilike.${like},slug.ilike.${like},id.eq.${q}`)
        : query.or(`name.ilike.${like},slug.ilike.${like}`);
      const { data } = await query;
      return (data ?? []).map((r) => ({
        kind: "client" as const,
        id: r.id,
        label: r.name ?? r.slug ?? r.id,
        href: `/clients/${r.id}`,
      }));
    })(),
  );

  // --- briefs --------------------------------------------------------------
  tasks.push(
    (async () => {
      let query = supabase.from("briefs").select("id, brief_id_human").limit(PER_KIND_LIMIT);
      query = isUuid
        ? query.or(`brief_id_human.ilike.${like},id.eq.${q}`)
        : query.ilike("brief_id_human", like);
      const { data } = await query;
      return (data ?? []).map((r) => ({
        kind: "brief" as const,
        id: r.id,
        label: r.brief_id_human ?? r.id,
        href: `/briefs/${r.id}`,
      }));
    })(),
  );

  // --- video_briefs --------------------------------------------------------
  tasks.push(
    (async () => {
      let query = supabase.from("video_briefs").select("id, brief_id_human").limit(PER_KIND_LIMIT);
      query = isUuid
        ? query.or(`brief_id_human.ilike.${like},id.eq.${q}`)
        : query.ilike("brief_id_human", like);
      const { data } = await query;
      return (data ?? []).map((r) => ({
        kind: "video_brief" as const,
        id: r.id,
        label: r.brief_id_human ?? r.id,
        href: `/briefs/${r.id}?format=video`,
      }));
    })(),
  );

  // --- creatives (image) ---------------------------------------------------
  tasks.push(
    (async () => {
      let query = supabase
        .from("creatives")
        .select("id, concept, asset_name, brief_id")
        .is("deleted_at", null)
        .limit(PER_KIND_LIMIT);
      query = isUuid
        ? query.or(`concept.ilike.${like},asset_name.ilike.${like},id.eq.${q}`)
        : query.or(`concept.ilike.${like},asset_name.ilike.${like}`);
      const { data } = await query;
      return (data ?? []).map((r) => ({
        kind: "creative" as const,
        id: r.id,
        label: r.asset_name ?? r.concept ?? r.id,
        href: `/creatives/${r.brief_id}`,
      }));
    })(),
  );

  // --- video_creatives -----------------------------------------------------
  tasks.push(
    (async () => {
      let query = supabase
        .from("video_creatives")
        .select("id, asset_name, brief_id")
        .is("deleted_at", null)
        .limit(PER_KIND_LIMIT);
      query = isUuid
        ? query.or(`asset_name.ilike.${like},id.eq.${q}`)
        : query.ilike("asset_name", like);
      const { data } = await query;
      return (data ?? []).map((r) => ({
        kind: "video_creative" as const,
        id: r.id,
        label: r.asset_name ?? r.id,
        href: `/creatives/${r.brief_id}?format=video`,
      }));
    })(),
  );

  // --- launch_packages (image) --------------------------------------------
  tasks.push(
    (async () => {
      let query = supabase
        .from("launch_packages")
        .select("id, status, brief_id")
        .is("deleted_at", null)
        .limit(PER_KIND_LIMIT);
      query = isUuid ? query.or(`status.ilike.${like},id.eq.${q}`) : query.ilike("status", like);
      const { data } = await query;
      return (data ?? []).map((r) => ({
        kind: "launch_package" as const,
        id: r.id,
        label: `Launch ${r.status ?? ""}`.trim(),
        href: `/launches/${r.id}`,
      }));
    })(),
  );

  // --- video_launch_packages ----------------------------------------------
  tasks.push(
    (async () => {
      let query = supabase
        .from("video_launch_packages")
        .select("id, status, brief_id")
        .is("deleted_at", null)
        .limit(PER_KIND_LIMIT);
      query = isUuid ? query.or(`status.ilike.${like},id.eq.${q}`) : query.ilike("status", like);
      const { data } = await query;
      return (data ?? []).map((r) => ({
        kind: "video_launch_package" as const,
        id: r.id,
        label: `Launch ${r.status ?? ""} (video)`.trim(),
        href: `/launches/${r.id}?format=video`,
      }));
    })(),
  );

  // --- pipelines (exact id only; no human-readable name column) ------------
  if (isUuid) {
    tasks.push(
      (async () => {
        const { data } = await supabase
          .from("pipelines")
          .select("id, status, format_choice")
          .eq("id", q)
          .limit(PER_KIND_LIMIT);
        return (data ?? []).map((r) => ({
          kind: "pipeline" as const,
          id: r.id,
          label: `Pipeline ${r.format_choice} / ${r.status}`,
          href: `/pipeline/${r.id}`,
        }));
      })(),
    );
  }

  const slices = await Promise.all(tasks);
  const results = slices.flat().slice(0, TOTAL_LIMIT);

  return NextResponse.json({ results });
}
