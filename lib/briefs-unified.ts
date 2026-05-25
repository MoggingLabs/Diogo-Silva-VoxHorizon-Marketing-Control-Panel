import { readBriefPayload, type Brief } from "@/lib/briefs";
import type { VideoBrief } from "@/lib/video-briefs";

/**
 * Unified Briefs view model (Makeover M3 / E3.1, #590).
 *
 * The image (`briefs`) and video (`video_briefs`) tables stay separate in the
 * DB, but the operator manages them in one list with a format tab. This module
 * defines the single row shape the unified `/briefs` DataTable renders and the
 * adapters that fold each source table into it. Keeping the mapping here (not in
 * the page) keeps it unit-testable and shared between the list page and tests.
 */

export type BriefFormat = "image" | "video";

/** One row in the unified Briefs table. */
export type UnifiedBriefRow = {
  /** DB primary key (uuid). */
  id: string;
  /** Which table this came from — drives the detail-link + format badge. */
  format: BriefFormat;
  /** Human-facing id, e.g. `acme-0007`. */
  briefIdHuman: string;
  /** Owning client uuid (nullable on legacy rows). */
  clientId: string | null;
  /** Resolved client display name (joined), or null when unknown. */
  clientName: string | null;
  /** Lifecycle status (same enum shape across both tables). */
  status: string;
  /**
   * Short "what" descriptor: service + market for image, dimensions + duration
   * for video. Used in the service/market column.
   */
  serviceMarket: string;
  /** ISO created timestamp. */
  createdAt: string;
  /** Soft-delete tombstone (null = active). */
  deletedAt: string | null;
  /** Deep link to the detail page (format-aware). */
  href: string;
};

/** A minimal client lookup map: `id -> name`. */
export type ClientNameMap = Record<string, string>;

/** Fold an image brief row into the unified shape. */
export function imageBriefToRow(
  brief: Pick<
    Brief,
    "id" | "brief_id_human" | "client_id" | "status" | "payload" | "created_at"
  > & { deleted_at?: string | null },
  clients: ClientNameMap = {},
): UnifiedBriefRow {
  const payload = readBriefPayload(brief);
  const parts: string[] = [];
  if (payload?.service) parts.push(payload.service);
  if (payload?.market) parts.push(payload.market);
  return {
    id: brief.id,
    format: "image",
    briefIdHuman: brief.brief_id_human,
    clientId: brief.client_id,
    clientName: brief.client_id ? (clients[brief.client_id] ?? null) : null,
    status: brief.status,
    serviceMarket: parts.join(" · "),
    createdAt: brief.created_at,
    deletedAt: brief.deleted_at ?? null,
    href: `/briefs/${brief.id}`,
  };
}

/** Fold a video brief row into the unified shape. */
export function videoBriefToRow(
  brief: Pick<
    VideoBrief,
    | "id"
    | "brief_id_human"
    | "client_id"
    | "status"
    | "created_at"
    | "dimensions"
    | "target_duration_s"
  > & { deleted_at?: string | null },
  clients: ClientNameMap = {},
): UnifiedBriefRow {
  const parts: string[] = [];
  if (brief.dimensions) parts.push(brief.dimensions);
  if (typeof brief.target_duration_s === "number") parts.push(`${brief.target_duration_s}s`);
  return {
    id: brief.id,
    format: "video",
    briefIdHuman: brief.brief_id_human,
    clientId: brief.client_id,
    clientName: brief.client_id ? (clients[brief.client_id] ?? null) : null,
    status: brief.status,
    serviceMarket: parts.join(" · "),
    createdAt: brief.created_at,
    deletedAt: brief.deleted_at ?? null,
    href: `/briefs/video/${brief.id}`,
  };
}

/**
 * Merge image + video rows into one list sorted by `createdAt` descending. The
 * format filter is applied by the caller (the DataTable) via the `format`
 * column; this just builds the superset.
 */
export function mergeBriefRows(
  image: UnifiedBriefRow[],
  video: UnifiedBriefRow[],
): UnifiedBriefRow[] {
  return [...image, ...video].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
