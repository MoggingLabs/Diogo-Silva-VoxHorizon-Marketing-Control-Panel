import { describe, expect, it } from "vitest";

import {
  IMAGE_FILENAME_REGEX,
  VIDEO_FILENAME_REGEX,
  buildImageFilename,
  buildVideoFilename,
  parseImageFilename,
  parseVideoFilename,
  validateImageFilename,
  validateVideoFilename,
} from "./naming";

describe("validateImageFilename", () => {
  it("accepts the canonical shape", () => {
    expect(validateImageFilename("Acme Roof | Kitchen | 1x1 | v1.0.png")).toEqual({
      ok: true,
      errors: [],
    });
    expect(IMAGE_FILENAME_REGEX.test("Acme Roof | Kitchen | 16x9 | v1.0.png")).toBe(true);
  });

  it("rejects with extension + segment + ratio + version errors", () => {
    const result = validateImageFilename("Acme|bad|wrong|nope.jpg");
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("Image filename must end with .png");
  });

  it("flags missing 4 segments", () => {
    const r = validateImageFilename("A | B | C.png");
    expect(r.ok).toBe(false);
    expect(r.errors).toContain("Image filename must have 4 ' | '-separated segments");
  });

  it("flags an invalid client label / concept / ratio / version", () => {
    const r = validateImageFilename("Bad! | con|cept | weird | v1.png");
    expect(r.ok).toBe(false);
    expect(r.errors.length).toBeGreaterThan(0);
  });
});

describe("validateVideoFilename", () => {
  it("accepts the canonical shape", () => {
    expect(validateVideoFilename("Acme Roof | Hook | 30s | v1.0.mp4")).toEqual({
      ok: true,
      errors: [],
    });
    expect(VIDEO_FILENAME_REGEX.test("X | Y | 15s | v2.3.mp4")).toBe(true);
  });

  it("flags bad extension + segments", () => {
    const r = validateVideoFilename("bad.png");
    expect(r.ok).toBe(false);
    expect(r.errors).toContain("Video filename must end with .mp4");
  });

  it("flags missing 4 segments", () => {
    const r = validateVideoFilename("A | B.mp4");
    expect(r.ok).toBe(false);
    expect(r.errors).toContain("Video filename must have 4 ' | '-separated segments");
  });

  it("flags an invalid client label / duration / version", () => {
    const r = validateVideoFilename("Bad! | con|cept | weird | v1.mp4");
    expect(r.ok).toBe(false);
    expect(r.errors.length).toBeGreaterThan(0);
  });
});

describe("buildImageFilename / buildVideoFilename", () => {
  it("composes a clean filename from parts", () => {
    expect(
      buildImageFilename({
        client_label: "Acme",
        concept: "Kitchen",
        ratio: "1x1",
        version: "1.0",
      }),
    ).toBe("Acme | Kitchen | 1x1 | v1.0.png");
  });

  it("strips a leading 'v' from the version", () => {
    expect(
      buildImageFilename({
        client_label: "Acme",
        concept: "Kitchen",
        ratio: "9x16",
        version: "v2.1",
      }),
    ).toBe("Acme | Kitchen | 9x16 | v2.1.png");
  });

  it("replaces stray pipes in client/concept with slashes", () => {
    expect(
      buildImageFilename({
        client_label: "A|B",
        concept: "Hook|s",
        ratio: "1x1",
        version: "1.0",
      }),
    ).toBe("A/B | Hook/s | 1x1 | v1.0.png");
  });

  it("composes a video filename", () => {
    expect(
      buildVideoFilename({
        client_label: "Acme",
        concept: "Hook",
        duration_s: 30,
        version: "v1.0",
      }),
    ).toBe("Acme | Hook | 30s | v1.0.mp4");
  });
});

describe("parseImageFilename / parseVideoFilename", () => {
  it("round-trips an image filename", () => {
    const parts = parseImageFilename("Acme Roof | Kitchen | 1x1 | v1.0.png");
    expect(parts).toEqual({
      client_label: "Acme Roof",
      concept: "Kitchen",
      ratio: "1x1",
      version: "v1.0",
    });
  });

  it("returns null for an invalid image filename", () => {
    expect(parseImageFilename("garbage")).toBeNull();
  });

  it("round-trips a video filename", () => {
    const parts = parseVideoFilename("Acme | Hook | 30s | v1.0.mp4");
    expect(parts).toEqual({
      client_label: "Acme",
      concept: "Hook",
      duration_s: 30,
      version: "v1.0",
    });
  });

  it("returns null for an invalid video filename", () => {
    expect(parseVideoFilename("garbage")).toBeNull();
  });
});
