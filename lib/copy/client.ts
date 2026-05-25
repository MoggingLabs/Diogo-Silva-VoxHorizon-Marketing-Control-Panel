/**
 * Thin fetch wrappers around the standalone copy CRUD routes (`/api/copy*`,
 * E3.3 / #592). Format-aware: every call carries `format` (image|video) so the
 * route writes the correct table (`copy_variants` vs `video_copy_variants`).
 */
import type { CopyFormatT } from "@/lib/copy/schemas";

function resolveBaseUrl(): string {
  if (typeof window !== "undefined") return "";
  const explicit = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (explicit) return explicit.replace(/\/$/, "");
  const vercel = process.env.VERCEL_URL?.trim();
  if (vercel) return `https://${vercel}`;
  return "http://localhost:3000";
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

export type CreateCopyBody = {
  format: CopyFormatT;
  creative_id: string;
  platform?: string;
  placement?: string;
  variant_index: number;
  headline?: string;
  body?: string;
  description?: string;
  cta?: string;
  pattern?: string;
  humanized?: boolean;
};

export async function createCopy(body: CreateCopyBody): Promise<void> {
  const res = await fetch(`${resolveBaseUrl()}/api/copy`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  await expectOk(res, "POST /api/copy");
}

export type UpdateCopyBody = {
  format: CopyFormatT;
  platform?: string;
  placement?: string;
  variant_index?: number;
  headline?: string;
  body?: string;
  description?: string;
  cta?: string;
  pattern?: string;
  humanized?: boolean;
};

export async function updateCopy(id: string, body: UpdateCopyBody): Promise<void> {
  const res = await fetch(`${resolveBaseUrl()}/api/copy/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  await expectOk(res, `PATCH /api/copy/${id}`);
}

export async function archiveCopy(format: CopyFormatT, id: string): Promise<void> {
  const res = await fetch(
    `${resolveBaseUrl()}/api/copy/${encodeURIComponent(id)}?format=${format}`,
    { method: "DELETE", cache: "no-store" },
  );
  await expectOk(res, `DELETE /api/copy/${id}`);
}

export async function restoreCopy(format: CopyFormatT, id: string): Promise<void> {
  const res = await fetch(
    `${resolveBaseUrl()}/api/copy/${encodeURIComponent(id)}/restore?format=${format}`,
    { method: "POST", cache: "no-store" },
  );
  await expectOk(res, `POST /api/copy/${id}/restore`);
}
