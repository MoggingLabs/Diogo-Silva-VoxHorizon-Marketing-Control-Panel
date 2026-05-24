import { describe, expect, it } from "vitest";

import { PRICING } from "./pricing";

describe("PRICING", () => {
  it("exposes the per-vendor pricing knobs", () => {
    expect(PRICING.kie_ai.per_image).toBeCloseTo(0.05);
    expect(PRICING.kie_video.per_clip).toBeCloseTo(0.4);
    expect(PRICING.elevenlabs.per_1k_chars).toBeCloseTo(0.3);
    expect(PRICING.submagic.per_video).toBeCloseTo(1.0);
    expect(PRICING.anthropic.per_million_input).toBeCloseTo(3.0);
    expect(PRICING.anthropic.per_million_output).toBeCloseTo(15.0);
    expect(PRICING.hyperframes.per_video).toBe(0.0);
    expect(PRICING.yt_dlp.per_clip).toBe(0.0);
  });
});
