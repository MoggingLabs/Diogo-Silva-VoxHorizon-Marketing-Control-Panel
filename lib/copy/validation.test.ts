import { describe, expect, it } from "vitest";

import { buildCopyValidation } from "./validation";

describe("buildCopyValidation", () => {
  it("records lengths without a cap for unlimited platforms (tiktok)", () => {
    const v = buildCopyValidation({
      platform: "tiktok",
      headline: "hi",
      body: "body text",
      description: "desc",
    });
    expect(v.ok).toBe(true);
    expect(v.headline).toEqual({ len: 2 });
    expect(v.primary_text).toEqual({ len: 9 });
    expect(v.description).toEqual({ len: 4 });
  });

  it("omits fields that are not provided (unlimited path)", () => {
    const v = buildCopyValidation({ platform: "tiktok", headline: "x" });
    expect(v.headline).toEqual({ len: 1 });
    expect(v.primary_text).toBeUndefined();
    expect(v.description).toBeUndefined();
  });

  it("counts against the meta limits and stays ok within bounds", () => {
    const v = buildCopyValidation({
      platform: "meta",
      placement: "feed",
      headline: "Short headline",
      body: "A reasonable primary text.",
    });
    expect(v.ok).toBe(true);
    const headline = v.headline as { len: number; max: number | null; status: string };
    expect(headline.len).toBeGreaterThan(0);
    expect(headline.status).toBe("ok");
  });

  it("flags ok:false when a meta field blows past its char limit", () => {
    // Meta headline limit is small (~40 for feed); 300 chars must error.
    const v = buildCopyValidation({
      platform: "meta",
      placement: "feed",
      headline: "x".repeat(300),
    });
    expect(v.ok).toBe(false);
    const headline = v.headline as { status: string; over: number };
    expect(headline.status).toBe("error");
    expect(headline.over).toBeGreaterThan(0);
  });

  it("ignores an unknown placement (falls back to undefined placement) on a limited platform", () => {
    const v = buildCopyValidation({
      platform: "google",
      placement: "marketplace", // not in the limited-placement set
      headline: "Headline",
    });
    // Still computes against the platform default; just shouldn't throw.
    expect(typeof v.ok).toBe("boolean");
    expect(v.headline).toBeDefined();
  });
});
