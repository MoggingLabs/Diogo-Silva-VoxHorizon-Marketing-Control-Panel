/**
 * Client-side fetch wrappers for the unified Creatives surface (M4 / #593/#594).
 *
 * Keeps the network code out of the grid + manage components so they stay
 * testable. Covers both image (`/api/creatives/*`) and video
 * (`/api/creatives/video/*`) creatives behind one `kind` discriminator, since
 * the makeover unifies the two surfaces under a single section while keeping the
 * dual backend tables.
 *
 * Mirrors the conventions in `lib/pipeline/client.ts`: relative URLs in the
 * browser, throw on non-2xx with the inlined error body so the caller can toast.
 */
import type { Creative, UpdateCreativeInputT } from "@/lib/creatives";
import type { UpdateVideoCreativeInputT, VideoCreative } from "@/lib/video-creatives";

/** Which backend table a creative lives in. */
export type CreativeKind = "image" | "video";

function basePath(kind: CreativeKind): string {
  return kind === "image" ? "/api/creatives" : "/api/creatives/video";
}

async function readError(res: Response, label: string): Promise<never> {
  const body = await res.text().catch(() => "");
  let message = body.slice(0, 200) || res.statusText;
  try {
    const parsed = JSON.parse(body) as { error?: string };
    if (parsed?.error) message = parsed.error;
  } catch {
    // non-JSON body; keep the raw slice
  }
  throw new Error(`${label} failed (${res.status}): ${message}`);
}

export type ListCreativesResult = { creatives: Creative[] };
export type ListVideoCreativesResult = { creatives: VideoCreative[] };

/**
 * List the whole active (or archived) set of image creatives for the grid.
 */
export async function listImageCreatives(opts: { archived?: boolean } = {}): Promise<Creative[]> {
  const qs = opts.archived ? "?archived=true" : "";
  const res = await fetch(`/api/creatives${qs}`, { cache: "no-store" });
  if (!res.ok) await readError(res, "GET /api/creatives");
  const data = (await res.json()) as ListCreativesResult;
  return data.creatives;
}

/**
 * List the whole active (or archived) set of video creatives for the grid.
 */
export async function listVideoCreatives(
  opts: { archived?: boolean } = {},
): Promise<VideoCreative[]> {
  const qs = opts.archived ? "?archived=true" : "";
  const res = await fetch(`/api/creatives/video${qs}`, { cache: "no-store" });
  if (!res.ok) await readError(res, "GET /api/creatives/video");
  const data = (await res.json()) as ListVideoCreativesResult;
  return data.creatives;
}

/** Edit an image creative's editable metadata. */
export async function updateImageCreative(
  id: string,
  patch: UpdateCreativeInputT,
): Promise<Creative> {
  const res = await fetch(`/api/creatives/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
    cache: "no-store",
  });
  if (!res.ok) await readError(res, `PATCH /api/creatives/${id}`);
  const data = (await res.json()) as { creative: Creative };
  return data.creative;
}

/** Edit a video creative's editable metadata. */
export async function updateVideoCreative(
  id: string,
  patch: UpdateVideoCreativeInputT,
): Promise<VideoCreative> {
  const res = await fetch(`/api/creatives/video/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
    cache: "no-store",
  });
  if (!res.ok) await readError(res, `PATCH /api/creatives/video/${id}`);
  const data = (await res.json()) as { creative: VideoCreative };
  return data.creative;
}

/** Archive (soft-delete) a creative of either kind. */
export async function archiveCreative(kind: CreativeKind, id: string): Promise<void> {
  const res = await fetch(`${basePath(kind)}/${encodeURIComponent(id)}`, {
    method: "DELETE",
    cache: "no-store",
  });
  if (!res.ok) await readError(res, `DELETE ${basePath(kind)}/${id}`);
}

/** Restore an archived creative of either kind. */
export async function restoreCreative(kind: CreativeKind, id: string): Promise<void> {
  const res = await fetch(`${basePath(kind)}/${encodeURIComponent(id)}/restore`, {
    method: "POST",
    cache: "no-store",
  });
  if (!res.ok) await readError(res, `POST ${basePath(kind)}/${id}/restore`);
}
