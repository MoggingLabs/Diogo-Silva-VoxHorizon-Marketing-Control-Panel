import { BriefsListClient } from "@/components/briefs/BriefsListClient";
import {
  imageBriefToRow,
  mergeBriefRows,
  videoBriefToRow,
  type ClientNameMap,
} from "@/lib/briefs-unified";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Briefs — VoxHorizon",
};

type SearchParams = { archived?: string };

/**
 * Unified Briefs list page (Makeover M3 / E3.1, #590).
 *
 * Server-fetches the image (`briefs`) + video (`video_briefs`) tables and the
 * client lookup, folds both into the shared `UnifiedBriefRow` shape, and hands
 * them to the client `BriefsListClient` (ResourceShell + DataTable + format
 * tab). `?archived=1` flips the page to the archived view (soft-deleted rows).
 */
export default async function BriefsListPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const { archived: archivedParam } = await searchParams;
  const archived = archivedParam === "1" || archivedParam === "true";
  const supabase = await createClient();

  // Soft-delete filter: active rows have `deleted_at is null`; the archived view
  // wants the inverse. We cast through `as never` only where the curated
  // types.gen lags the live column (briefs/video_briefs gained `deleted_at` in
  // migration 0049, reflected in types.gen here).
  function applyArchive<
    Q extends { is(c: string, v: null): Q; not(c: string, op: string, v: null): Q },
  >(q: Q): Q {
    return archived ? q.not("deleted_at", "is", null) : q.is("deleted_at", null);
  }

  const [imageRes, videoRes, clientsRes] = await Promise.all([
    applyArchive(
      supabase
        .from("briefs")
        .select("id, brief_id_human, client_id, status, payload, created_at, deleted_at")
        .order("created_at", { ascending: false })
        .limit(500),
    ),
    applyArchive(
      supabase
        .from("video_briefs")
        .select(
          "id, brief_id_human, client_id, status, created_at, dimensions, target_duration_s, deleted_at",
        )
        .order("created_at", { ascending: false })
        .limit(500),
    ),
    supabase.from("clients").select("id, name"),
  ]);

  const clientMap: ClientNameMap = {};
  for (const c of clientsRes.data ?? []) {
    if (c.id && c.name) clientMap[c.id] = c.name;
  }

  const imageRows = (imageRes.data ?? []).map((b) => imageBriefToRow(b, clientMap));
  const videoRows = (videoRes.data ?? []).map((b) => videoBriefToRow(b, clientMap));
  const rows = mergeBriefRows(imageRows, videoRows);

  const loadError = imageRes.error?.message ?? videoRes.error?.message ?? null;

  return (
    <>
      {loadError ? (
        <div className="mx-auto w-full max-w-7xl px-4 pt-6 sm:px-6">
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            Failed to load briefs: {loadError}
          </div>
        </div>
      ) : null}
      <BriefsListClient rows={rows} archived={archived} />
    </>
  );
}
