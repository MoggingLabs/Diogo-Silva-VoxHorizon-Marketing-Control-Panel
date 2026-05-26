/**
 * Thin fetch wrappers around the `/api/briefs` + `/api/briefs/video` routes for
 * the unified Briefs UI (Makeover M3). Keeping the network code out of the
 * components keeps them testable and gives one place to evolve the contract.
 *
 * Format-aware: every mutation takes a `BriefFormat` and hits the matching
 * table's route (`image -> /api/briefs/...`, `video -> /api/briefs/video/...`).
 */
import type { BriefFormat } from "@/lib/briefs-unified";

function resolveBaseUrl(): string {
  if (typeof window !== "undefined") return "";
  const explicit = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (explicit) return explicit.replace(/\/$/, "");
  const vercel = process.env.VERCEL_URL?.trim();
  if (vercel) return `https://${vercel}`;
  return "http://localhost:3000";
}

function basePath(format: BriefFormat): string {
  return format === "video" ? "/api/briefs/video" : "/api/briefs";
}

async function expectOk(res: Response, label: string): Promise<unknown> {
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  if (!res.ok) {
    const message =
      parsed && typeof parsed === "object" && "error" in parsed
        ? String((parsed as { error: unknown }).error)
        : text.slice(0, 200) || res.statusText;
    throw new Error(`${label} failed (${res.status}): ${message}`);
  }
  return parsed;
}

/** Archive (soft-delete) a brief of the given format. */
export async function archiveBrief(format: BriefFormat, id: string): Promise<void> {
  const res = await fetch(`${resolveBaseUrl()}${basePath(format)}/${encodeURIComponent(id)}`, {
    method: "DELETE",
    cache: "no-store",
  });
  await expectOk(res, `DELETE ${basePath(format)}/${id}`);
}

/** Restore an archived brief of the given format. */
export async function restoreBrief(format: BriefFormat, id: string): Promise<void> {
  const res = await fetch(
    `${resolveBaseUrl()}${basePath(format)}/${encodeURIComponent(id)}/restore`,
    { method: "POST", cache: "no-store" },
  );
  await expectOk(res, `POST ${basePath(format)}/${id}/restore`);
}

/**
 * PATCH an image brief's payload and/or status. The image route returns
 * `{ brief }`. Throws with the inline error on a 4xx/5xx (e.g. a 409 on a
 * disallowed status transition).
 */
export async function updateImageBrief(
  id: string,
  body: { payload?: Record<string, unknown>; status?: string },
): Promise<void> {
  const res = await fetch(`${resolveBaseUrl()}/api/briefs/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  await expectOk(res, `PATCH /api/briefs/${id}`);
}

/**
 * PATCH a video brief. The video route accepts the partial-edit shape
 * (`script_outline`, `target_duration_s`, `voice_id`, ... and/or `status`) and
 * returns the row directly.
 */
export async function updateVideoBrief(id: string, body: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${resolveBaseUrl()}/api/briefs/video/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  await expectOk(res, `PATCH /api/briefs/video/${id}`);
}
