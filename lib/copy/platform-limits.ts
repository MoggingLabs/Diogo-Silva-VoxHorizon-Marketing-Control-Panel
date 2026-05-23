/**
 * Per-platform / per-placement character limits for ad copy fields.
 *
 * Supports the CopyComposer (#359, P4.4): each authored variant is validated
 * against the destination platform's published limits so the operator never
 * ships copy that Ads Manager will silently truncate or reject.
 *
 * Two thresholds per field where the platform publishes both:
 *   - `recommended` — the soft cap. Meta truncates the feed primary text with a
 *     "... See more" link past ~125 chars; headlines past ~40 wrap or clip on
 *     mobile. Going over is allowed but degrades the preview, so we `warn`.
 *   - `max` — the hard cap the API enforces. Over this is an `error`.
 *
 * Numbers are sourced from the donor copy-authoring knowledge
 * (`ekko-skills/copy-authoring/references/ad-copy-standards.md` +
 * `copy-authoring/SKILL.md`, "headline under 40 chars", "primary text limits")
 * cross-checked against the Meta and Google ad-platform published specs current
 * as of the rebuild. They are data, not behaviour: when a platform churns its
 * limits, edit the table, not the counter logic.
 *
 * This module is pure (no React, no IO) so it is unit-testable in the `node`
 * vitest project and reusable by both the live CharCounter and any server-side
 * validation that lands when `copy_variants` is wired.
 */

/** Platforms we author copy for today. Extend as new destinations land. */
export type CopyPlatform = "meta" | "google";

/**
 * Placement within a platform. `undefined` placement falls back to the
 * platform's default surface (`meta` → feed, `google` → rsa).
 */
export type CopyPlacement = "feed" | "stories" | "reels" | "rsa" | "pmax";

/** Copy fields a variant carries. */
export type CopyField = "headline" | "primary_text" | "description";

/** Outcome of a single count check against a field's limits. */
export type CountStatus = "ok" | "warn" | "error";

/**
 * A field's limits. `recommended` is optional — some fields (Meta description,
 * Google RSA fields) publish only a hard cap.
 */
export type FieldLimit = {
  /** Soft cap. At or below → `ok`; over (but ≤ max) → `warn`. */
  recommended?: number;
  /** Hard cap. Over → `error`. */
  max: number;
};

/** All fields' limits for a single platform/placement surface. */
export type PlacementLimits = Partial<Record<CopyField, FieldLimit>>;

/**
 * The canonical limits table: platform → placement → field → limit.
 *
 * Meta feed: primary text recommended ~125 (truncation point), hard cap 2200;
 *   headline ~40 rec / 255 max; description ~30 rec / 255 max (link
 *   description, shown on some placements).
 * Meta stories / reels: shorter recommended primary because the overlay UI
 *   covers the lower third; same hard caps.
 * Google RSA: headline 30, description 90 (hard caps, no published soft cap).
 * Google PMax: same field caps as RSA (shared asset model).
 */
export const PLATFORM_LIMITS: Record<
  CopyPlatform,
  Partial<Record<CopyPlacement, PlacementLimits>>
> = {
  meta: {
    feed: {
      primary_text: { recommended: 125, max: 2200 },
      headline: { recommended: 40, max: 255 },
      description: { recommended: 30, max: 255 },
    },
    stories: {
      primary_text: { recommended: 70, max: 2200 },
      headline: { recommended: 40, max: 255 },
      description: { recommended: 30, max: 255 },
    },
    reels: {
      primary_text: { recommended: 72, max: 2200 },
      headline: { recommended: 40, max: 255 },
      description: { recommended: 30, max: 255 },
    },
  },
  google: {
    rsa: {
      headline: { max: 30 },
      description: { max: 90 },
    },
    pmax: {
      headline: { max: 30 },
      description: { max: 90 },
      primary_text: { max: 90 },
    },
  },
};

/** Default placement per platform when the caller omits one. */
export const DEFAULT_PLACEMENT: Record<CopyPlatform, CopyPlacement> = {
  meta: "feed",
  google: "rsa",
};

/** Result of {@link countWithStatus}. */
export type CountResult = {
  /** Character length of the (trimmed-of-nothing) input. */
  len: number;
  /** Soft cap for this field/surface, when published. */
  recommended?: number;
  /** Hard cap for this field/surface. */
  max: number;
  /** `ok` ≤ recommended; `warn` over recommended ≤ max; `error` over max. */
  status: CountStatus;
  /** Characters over the hard cap (0 unless `status === 'error'`). */
  over: number;
};

/**
 * Look up the published limit for a field on a platform/placement surface.
 *
 * Returns `undefined` when the surface or field is not in the table (e.g. a
 * Meta description has no meaning on a Google RSA). Callers decide how to treat
 * an unknown field — {@link countWithStatus} treats it as unlimited (`ok`).
 */
export function getFieldLimit(
  field: CopyField,
  platform: CopyPlatform,
  placement?: CopyPlacement,
): FieldLimit | undefined {
  const resolved = placement ?? DEFAULT_PLACEMENT[platform];
  return PLATFORM_LIMITS[platform][resolved]?.[field];
}

/**
 * Count a string against a field's published limits and classify it.
 *
 * Uses the spread operator to count by Unicode code points rather than UTF-16
 * code units, so an emoji or astral character counts as one "character" the way
 * a human (and most platform counters) read it.
 *
 * When no limit is published for the surface/field, the text is treated as
 * unlimited: `status: 'ok'`, `max: Infinity`, `over: 0`.
 */
export function countWithStatus(
  text: string,
  field: CopyField,
  platform: CopyPlatform,
  placement?: CopyPlacement,
): CountResult {
  const len = [...text].length;
  const limit = getFieldLimit(field, platform, placement);

  if (!limit) {
    return { len, max: Number.POSITIVE_INFINITY, status: "ok", over: 0 };
  }

  const { recommended, max } = limit;
  let status: CountStatus = "ok";
  if (len > max) {
    status = "error";
  } else if (recommended !== undefined && len > recommended) {
    status = "warn";
  }

  return {
    len,
    ...(recommended !== undefined ? { recommended } : {}),
    max,
    status,
    over: len > max ? len - max : 0,
  };
}
