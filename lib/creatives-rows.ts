import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { getSignedUrl as getImageSignedUrl } from "@/lib/creatives";
import type { Database } from "@/lib/supabase/types.gen";

/**
 * Server-side builder for the unified Creatives grid rows (M4 / #593).
 *
 * Reads both `creatives` and `video_creatives` (active or archived), resolves
 * each row's human brief id, and signs the image thumbnails, then flattens both
 * into one `CreativeRow[]` the grid client component renders. Shared by the
 * `/creatives` page (active set, server-rendered) and the
 * `/api/creatives/archived` route (archived set, fetched on demand) so the row
 * shape stays identical across both.
 *
 * Video has no still thumbnail in the schema, so `thumbnail_url` is null for
 * video rows today; the grid renders a film placeholder.
 */

type AnyClient = SupabaseClient<Database>;

/** One unified row — keep in sync with `components/creative/CreativesGrid.tsx`. */
export type CreativeRow = {
  id: string;
  kind: "image" | "video";
  brief_id: string;
  brief_label: string;
  concept: string | null;
  format_label: string | null;
  status: string;
  version: string;
  created_at: string;
  thumbnail_url: string | null;
  href: string;
};

type ImageCreative = Database["public"]["Tables"]["creatives"]["Row"];
type VideoCreative = Database["public"]["Tables"]["video_creatives"]["Row"];

const MANAGE_IMAGE = "/creatives/manage";
const MANAGE_VIDEO = "/creatives/manage/video";

/**
 * Build the unified rows. `admin` is required to sign image thumbnails (the
 * `creatives` bucket is private). Pass `archived: true` to list the archived
 * set instead of the active set.
 */
export async function buildCreativeRows(
  admin: AnyClient,
  opts: { archived?: boolean } = {},
): Promise<{ rows: CreativeRow[]; error: string | null }> {
  const archived = opts.archived ?? false;

  const imageQ = admin
    .from("creatives")
    .select("id, brief_id, concept, ratio, status, version, created_at, file_path_supabase")
    .order("created_at", { ascending: false })
    .limit(1000);
  const videoQ = admin
    .from("video_creatives")
    .select("id, brief_id, status, version, created_at, asset_name")
    .order("created_at", { ascending: false })
    .limit(1000);

  const [imageRes, videoRes] = await Promise.all([
    archived ? imageQ.not("deleted_at", "is", null) : imageQ.is("deleted_at", null),
    archived ? videoQ.not("deleted_at", "is", null) : videoQ.is("deleted_at", null),
  ]);

  const error = imageRes.error?.message ?? videoRes.error?.message ?? null;
  const imageRows = (imageRes.data ?? []) as Array<
    Pick<
      ImageCreative,
      | "id"
      | "brief_id"
      | "concept"
      | "ratio"
      | "status"
      | "version"
      | "created_at"
      | "file_path_supabase"
    >
  >;
  const videoRows = (videoRes.data ?? []) as Array<
    Pick<VideoCreative, "id" | "brief_id" | "status" | "version" | "created_at" | "asset_name">
  >;

  // Resolve brief human ids for both sides in two batched lookups.
  const imageBriefIds = Array.from(new Set(imageRows.map((r) => r.brief_id)));
  const videoBriefIds = Array.from(new Set(videoRows.map((r) => r.brief_id)));

  const [imageBriefs, videoBriefs] = await Promise.all([
    imageBriefIds.length > 0
      ? admin.from("briefs").select("id, brief_id_human").in("id", imageBriefIds)
      : Promise.resolve({ data: [] as { id: string; brief_id_human: string }[], error: null }),
    videoBriefIds.length > 0
      ? admin.from("video_briefs").select("id, brief_id_human").in("id", videoBriefIds)
      : Promise.resolve({ data: [] as { id: string; brief_id_human: string }[], error: null }),
  ]);

  const imageBriefMap = new Map<string, string>();
  for (const b of (imageBriefs.data ?? []) as { id: string; brief_id_human: string }[]) {
    imageBriefMap.set(b.id, b.brief_id_human);
  }
  const videoBriefMap = new Map<string, string>();
  for (const b of (videoBriefs.data ?? []) as { id: string; brief_id_human: string }[]) {
    videoBriefMap.set(b.id, b.brief_id_human);
  }

  // Sign image thumbnails in parallel; null on failure (placeholder rendered).
  const signed = await Promise.all(
    imageRows.map((r) => getImageSignedUrl(admin, r.file_path_supabase)),
  );

  const rows: CreativeRow[] = [];
  imageRows.forEach((r, i) => {
    rows.push({
      id: r.id,
      kind: "image",
      brief_id: r.brief_id,
      brief_label: imageBriefMap.get(r.brief_id) ?? r.brief_id.slice(0, 8),
      concept: r.concept ?? null,
      format_label: r.ratio ?? null,
      status: r.status,
      version: r.version,
      created_at: r.created_at,
      thumbnail_url: signed[i] ?? null,
      href: `${MANAGE_IMAGE}/${r.id}`,
    });
  });
  for (const r of videoRows) {
    rows.push({
      id: r.id,
      kind: "video",
      brief_id: r.brief_id,
      brief_label: videoBriefMap.get(r.brief_id) ?? r.brief_id.slice(0, 8),
      concept: r.asset_name ?? null,
      format_label: null,
      status: r.status,
      version: `v${r.version}`,
      created_at: r.created_at,
      thumbnail_url: null,
      href: `${MANAGE_VIDEO}/${r.id}`,
    });
  }

  // Newest-first across both kinds.
  rows.sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));

  return { rows, error };
}
