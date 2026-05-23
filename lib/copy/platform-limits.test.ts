/**
 * Tests for the platform char-limit table + counter logic. Pure module, so we
 * cover every status transition (ok/warn/error), the recommended-vs-max split,
 * the placement fallback, unicode counting, and the unlimited-surface path.
 */
import { describe, expect, it } from "vitest";

import {
  countWithStatus,
  getFieldLimit,
  PLATFORM_LIMITS,
  DEFAULT_PLACEMENT,
  type CountResult,
} from "./platform-limits";

describe("PLATFORM_LIMITS table", () => {
  it("encodes the Meta feed primary-text 125 rec / 2200 max spec", () => {
    expect(PLATFORM_LIMITS.meta.feed?.primary_text).toEqual({
      recommended: 125,
      max: 2200,
    });
  });

  it("encodes the Meta feed headline ~40 rec spec", () => {
    expect(PLATFORM_LIMITS.meta.feed?.headline?.recommended).toBe(40);
  });

  it("encodes the Meta feed description ~30 rec spec", () => {
    expect(PLATFORM_LIMITS.meta.feed?.description?.recommended).toBe(30);
  });

  it("gives Meta stories/reels a shorter recommended primary text", () => {
    const feed = PLATFORM_LIMITS.meta.feed?.primary_text?.recommended ?? 0;
    const stories = PLATFORM_LIMITS.meta.stories?.primary_text?.recommended ?? 0;
    const reels = PLATFORM_LIMITS.meta.reels?.primary_text?.recommended ?? 0;
    expect(stories).toBeLessThan(feed);
    expect(reels).toBeLessThan(feed);
  });

  it("encodes Google RSA headline 30 / description 90 hard caps with no soft cap", () => {
    expect(PLATFORM_LIMITS.google.rsa?.headline).toEqual({ max: 30 });
    expect(PLATFORM_LIMITS.google.rsa?.description).toEqual({ max: 90 });
  });

  it("encodes Google PMax shared asset caps", () => {
    expect(PLATFORM_LIMITS.google.pmax?.headline?.max).toBe(30);
    expect(PLATFORM_LIMITS.google.pmax?.description?.max).toBe(90);
  });

  it("defaults meta→feed and google→rsa", () => {
    expect(DEFAULT_PLACEMENT.meta).toBe("feed");
    expect(DEFAULT_PLACEMENT.google).toBe("rsa");
  });
});

describe("getFieldLimit", () => {
  it("returns the explicit placement's limit", () => {
    expect(getFieldLimit("headline", "meta", "feed")).toEqual({
      recommended: 40,
      max: 255,
    });
  });

  it("falls back to the platform default placement when omitted", () => {
    expect(getFieldLimit("headline", "meta")).toEqual(getFieldLimit("headline", "meta", "feed"));
    expect(getFieldLimit("headline", "google")).toEqual(getFieldLimit("headline", "google", "rsa"));
  });

  it("returns undefined for a field not published on the surface", () => {
    // Google RSA has no primary_text field.
    expect(getFieldLimit("primary_text", "google", "rsa")).toBeUndefined();
  });

  it("returns undefined for an unknown placement", () => {
    expect(getFieldLimit("headline", "meta", "rsa")).toBeUndefined();
  });
});

describe("countWithStatus", () => {
  it("reports ok at or below the recommended cap", () => {
    const r = countWithStatus("a".repeat(40), "headline", "meta", "feed");
    expect(r).toMatchObject<Partial<CountResult>>({
      len: 40,
      recommended: 40,
      max: 255,
      status: "ok",
      over: 0,
    });
  });

  it("reports warn when over recommended but at/under max", () => {
    const r = countWithStatus("a".repeat(41), "headline", "meta", "feed");
    expect(r.status).toBe("warn");
    expect(r.over).toBe(0);
  });

  it("reports warn exactly at max (not error)", () => {
    const r = countWithStatus("a".repeat(255), "headline", "meta", "feed");
    expect(r.status).toBe("warn");
    expect(r.over).toBe(0);
  });

  it("reports error and the overage past the hard cap", () => {
    const r = countWithStatus("a".repeat(256), "headline", "meta", "feed");
    expect(r.status).toBe("error");
    expect(r.over).toBe(1);
  });

  it("reports error for primary text past the 2200 hard cap", () => {
    const r = countWithStatus("a".repeat(2201), "primary_text", "meta", "feed");
    expect(r.status).toBe("error");
    expect(r.over).toBe(1);
  });

  it("handles a field with only a hard cap (no recommended) — ok under", () => {
    const r = countWithStatus("a".repeat(30), "headline", "google", "rsa");
    expect(r.status).toBe("ok");
    expect(r.recommended).toBeUndefined();
    expect(r.max).toBe(30);
  });

  it("goes straight from ok to error when there is no recommended cap", () => {
    const r = countWithStatus("a".repeat(31), "headline", "google", "rsa");
    expect(r.status).toBe("error");
    expect(r.over).toBe(1);
  });

  it("uses the platform default placement when omitted", () => {
    const withDefault = countWithStatus("a".repeat(40), "headline", "meta");
    const explicit = countWithStatus("a".repeat(40), "headline", "meta", "feed");
    expect(withDefault).toEqual(explicit);
  });

  it("treats an unpublished surface/field as unlimited (ok, Infinity max)", () => {
    const r = countWithStatus("a".repeat(5000), "primary_text", "google", "rsa");
    expect(r.status).toBe("ok");
    expect(r.max).toBe(Number.POSITIVE_INFINITY);
    expect(r.over).toBe(0);
    expect(r.recommended).toBeUndefined();
  });

  it("counts by unicode code point, not UTF-16 code unit", () => {
    // An astral emoji is 2 UTF-16 units but 1 grapheme/code point.
    const r = countWithStatus("😀😀😀", "headline", "meta", "feed");
    expect(r.len).toBe(3);
  });

  it("counts an empty string as zero and ok", () => {
    const r = countWithStatus("", "headline", "meta", "feed");
    expect(r.len).toBe(0);
    expect(r.status).toBe("ok");
  });
});
