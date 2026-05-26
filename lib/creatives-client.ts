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

/** Per-creative result row returned by a QA re-run. */
export type QARerunResult = {
  ok: boolean;
  rollup: string;
  results: Array<{
    creative_id: string;
    verdict: string;
    status: string;
    attempt: number;
    rerender_recommended: boolean;
    defect_count: number;
  }>;
  errors: Array<{ creative_id: string; error: string }>;
};

/**
 * Re-run QA for a creative (APPEND-ONLY: the worker posts a NEW qa_result
 * attempt; it never edits a prior one). The route resolves the creative from
 * the image OR video store, so one path covers both kinds.
 */
export async function rerunQa(
  id: string,
  opts: { surface?: CreativeKind; ratio?: string } = {},
): Promise<QARerunResult> {
  const res = await fetch(`/api/creatives/${encodeURIComponent(id)}/qa`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(opts),
    cache: "no-store",
  });
  if (!res.ok) await readError(res, `POST /api/creatives/${id}/qa`);
  return (await res.json()) as QARerunResult;
}

/** Input for a manager spec override (one placement). */
export type SpecOverrideInputT = {
  platform?: "meta" | "google" | "tiktok";
  placement: string;
  status: "pending" | "pass" | "warn" | "fail" | "exception";
  reason: string;
  ratio?: string;
};

/**
 * Submit a manager spec override (OVERRIDE-ROUTE only: a corrected per-placement
 * result through the worker upsert + the DB rollup, with a required reason).
 */
export async function overrideSpec(id: string, input: SpecOverrideInputT): Promise<unknown> {
  const res = await fetch(`/api/creatives/${encodeURIComponent(id)}/spec`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
    cache: "no-store",
  });
  if (!res.ok) await readError(res, `POST /api/creatives/${id}/spec`);
  return (await res.json()) as unknown;
}

/** Input for a manager compliance override (one creative). */
export type ComplianceOverrideInputT = {
  creative_id: string;
  override_note: string;
  copy_variant_id?: string;
};

/**
 * Submit a manager compliance override via the EXISTING pipeline-scoped route
 * (OVERRIDE-ROUTE only: the only path that releases a hard compliance block;
 * the failing findings are retained, the override columns are stamped).
 */
export async function overrideCompliance(
  pipelineId: string,
  input: ComplianceOverrideInputT,
): Promise<unknown> {
  const res = await fetch(`/api/pipelines/${encodeURIComponent(pipelineId)}/compliance/override`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
    cache: "no-store",
  });
  if (!res.ok) await readError(res, `POST /api/pipelines/${pipelineId}/compliance/override`);
  return (await res.json()) as unknown;
}
