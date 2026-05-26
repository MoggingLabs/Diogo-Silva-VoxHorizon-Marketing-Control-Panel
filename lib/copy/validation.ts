import {
  countWithStatus,
  type CopyField,
  type CopyPlatform,
  type CopyPlacement,
} from "@/lib/copy/platform-limits";

/**
 * Per-field char-count validation for a copy variant against the destination
 * platform's published limits (#359). Lifted out of the pipeline copy route so
 * the standalone copy CRUD (E3.3 / #592) computes the identical `validation`
 * jsonb. Stored on the row so the launch validator + editor read it without
 * recomputing.
 */

const LIMITED_PLATFORMS: ReadonlySet<string> = new Set(["meta", "google"]);
const LIMITED_PLACEMENTS: ReadonlySet<string> = new Set([
  "feed",
  "stories",
  "reels",
  "rsa",
  "pmax",
]);

export type CopyValidationInput = {
  platform: string;
  placement?: string | null;
  headline?: string;
  body?: string;
  description?: string;
};

/**
 * Build the `validation` jsonb: per-field char-count status against the
 * platform's published limits. For unlimited platforms (e.g. tiktok) we record
 * the lengths without a cap and mark `ok: true`.
 */
export function buildCopyValidation(input: CopyValidationInput): Record<string, unknown> {
  if (!LIMITED_PLATFORMS.has(input.platform)) {
    const result: Record<string, unknown> = { ok: true };
    if (input.headline !== undefined) result.headline = { len: [...input.headline].length };
    if (input.body !== undefined) result.primary_text = { len: [...input.body].length };
    if (input.description !== undefined)
      result.description = { len: [...input.description].length };
    return result;
  }

  const platform = input.platform as CopyPlatform;
  const placement =
    input.placement && LIMITED_PLACEMENTS.has(input.placement)
      ? (input.placement as CopyPlacement)
      : undefined;

  const fields: Array<[CopyField, string | undefined]> = [
    ["headline", input.headline],
    ["primary_text", input.body],
    ["description", input.description],
  ];
  const result: Record<string, unknown> = {};
  let ok = true;
  for (const [field, value] of fields) {
    if (value === undefined) continue;
    const r = countWithStatus(value, field, platform, placement);
    result[field] = {
      len: r.len,
      max: Number.isFinite(r.max) ? r.max : null,
      status: r.status,
      over: r.over,
    };
    if (r.status === "error") ok = false;
  }
  result.ok = ok;
  return result;
}
