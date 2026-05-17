import { describe, expect, it } from "vitest";

import { activeTracksLocal, canAdvance, nextStage } from "./transitions";

describe("activeTracksLocal", () => {
  it.each([
    ["image", { image: true, video: false }],
    ["video", { image: false, video: true }],
    ["both", { image: true, video: true }],
  ] as const)("format=%s → %o", (fmt, expected) => {
    expect(activeTracksLocal(fmt)).toEqual(expected);
  });
});

describe("canAdvance: configuration→ideation", () => {
  const base = {
    status: "configuration" as const,
    format_choice: "image" as const,
    config_draft: { image_payload: { service: "roofing" } },
  };

  it("OK when image_payload exists", () => {
    expect(canAdvance(base)).toEqual({ ok: true, next: "ideation" });
  });

  it("OK when both payloads present for format=both", () => {
    expect(
      canAdvance({
        status: "configuration",
        format_choice: "both",
        config_draft: {
          image_payload: { x: 1 },
          video_payload: { y: 2 },
        },
      }),
    ).toEqual({ ok: true, next: "ideation" });
  });

  it("Flags missing video_payload for format=video", () => {
    expect(
      canAdvance({
        status: "configuration",
        format_choice: "video",
        config_draft: {},
      }),
    ).toMatchObject({ ok: false, missing: ["video_payload"] });
  });

  it("Flags both missing payloads for format=both", () => {
    const r = canAdvance({
      status: "configuration",
      format_choice: "both",
      config_draft: null,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.missing).toEqual(["image_payload", "video_payload"]);
  });

  it("Rejects array values where a plain object is required", () => {
    const r = canAdvance({
      status: "configuration",
      format_choice: "image",
      config_draft: { image_payload: [] } as Record<string, unknown>,
    });
    expect(r.ok).toBe(false);
  });
});

describe("canAdvance: stub stages + terminal states", () => {
  it("ideation / review / generation return a not-yet-supported reason", () => {
    for (const status of ["ideation", "review", "generation"] as const) {
      const r = canAdvance({
        status,
        format_choice: "image",
        config_draft: {},
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/not yet supported/);
    }
  });

  it("done is rejected", () => {
    const r = canAdvance({
      status: "done",
      format_choice: "image",
      config_draft: {},
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/already done/);
  });

  it("cancelled is rejected", () => {
    const r = canAdvance({
      status: "cancelled",
      format_choice: "image",
      config_draft: {},
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/cancelled/);
  });
});

describe("nextStage", () => {
  it.each([
    ["configuration", "ideation"],
    ["ideation", "review"],
    ["review", "generation"],
    ["generation", "done"],
    ["done", null],
    ["cancelled", null],
  ] as const)("%s → %s", (from, to) => {
    expect(nextStage(from)).toBe(to);
  });
});
