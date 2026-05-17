import { describe, expect, it } from "vitest";

import { activeTracks, isTrackActive } from "./tracks";

describe("activeTracks", () => {
  it("returns [image] for image format", () => {
    expect(activeTracks("image")).toEqual(["image"]);
  });

  it("returns [video] for video format", () => {
    expect(activeTracks("video")).toEqual(["video"]);
  });

  it("returns [image, video] for both, in stable order", () => {
    expect(activeTracks("both")).toEqual(["image", "video"]);
  });
});

describe("isTrackActive", () => {
  it("image format: image active, video inactive", () => {
    expect(isTrackActive("image", "image")).toBe(true);
    expect(isTrackActive("image", "video")).toBe(false);
  });

  it("video format: video active, image inactive", () => {
    expect(isTrackActive("video", "image")).toBe(false);
    expect(isTrackActive("video", "video")).toBe(true);
  });

  it("both format: image and video both active", () => {
    expect(isTrackActive("both", "image")).toBe(true);
    expect(isTrackActive("both", "video")).toBe(true);
  });
});
