import { describe, expect, it } from "vitest";

import { estimatePipelineCost } from "./cost-estimator";
import { PRICING } from "./pricing";

const ANTHROPIC_PER_ITER =
  (100_000 / 1_000_000) * PRICING.anthropic.per_million_input +
  (5_000 / 1_000_000) * PRICING.anthropic.per_million_output;

describe("estimatePipelineCost", () => {
  it("image-only with 2 picks emits Kie.ai and Anthropic rows", () => {
    const result = estimatePipelineCost({
      format: "image",
      picked_image_count: 2,
      picked_video_count: 0,
    });

    expect(result.items).toHaveLength(2);

    const kie = result.items.find((i) => i.api === "Kie.ai");
    expect(kie).toBeDefined();
    expect(kie?.units).toBe(4); // 2 picks * 2 ratios
    expect(kie?.unit_cost).toBe(PRICING.kie_ai.per_image);
    expect(kie?.subtotal).toBeCloseTo(0.2, 4);

    const anthropic = result.items.find((i) => i.api === "Anthropic");
    expect(anthropic).toBeDefined();
    expect(anthropic?.units).toBe(1);
    expect(anthropic?.subtotal).toBeCloseTo(ANTHROPIC_PER_ITER, 4);

    expect(result.total).toBeCloseTo(0.2 + ANTHROPIC_PER_ITER, 4);
  });

  it("video-only with 1 pick uses default script chars + emits EL/Submagic/Anthropic", () => {
    const result = estimatePipelineCost({
      format: "video",
      picked_image_count: 0,
      picked_video_count: 1,
    });

    expect(result.items.map((i) => i.api)).toEqual(["ElevenLabs", "Submagic", "Anthropic"]);

    const el = result.items.find((i) => i.api === "ElevenLabs");
    expect(el?.units).toBeCloseTo(0.8, 4); // 800 / 1000
    expect(el?.subtotal).toBeCloseTo(0.24, 4);

    const sub = result.items.find((i) => i.api === "Submagic");
    expect(sub?.units).toBe(1);
    expect(sub?.subtotal).toBeCloseTo(1.0, 4);

    expect(result.total).toBeCloseTo(0.24 + 1.0 + ANTHROPIC_PER_ITER, 4);
  });

  it("both format with 2 images + 1 video sums all relevant rows", () => {
    const result = estimatePipelineCost({
      format: "both",
      picked_image_count: 2,
      picked_video_count: 1,
    });

    expect(result.items.map((i) => i.api)).toEqual([
      "Kie.ai",
      "ElevenLabs",
      "Submagic",
      "Anthropic",
    ]);

    const expected = 0.2 + 0.24 + 1.0 + ANTHROPIC_PER_ITER;
    expect(result.total).toBeCloseTo(expected, 4);
  });

  it("zero picks returns empty items and zero total", () => {
    const result = estimatePipelineCost({
      format: "both",
      picked_image_count: 0,
      picked_video_count: 0,
    });

    expect(result.items).toEqual([]);
    expect(result.total).toBe(0);
  });

  it("respects estimated_script_chars override", () => {
    const result = estimatePipelineCost({
      format: "video",
      picked_image_count: 0,
      picked_video_count: 2,
      estimated_script_chars: 1500,
    });

    const el = result.items.find((i) => i.api === "ElevenLabs");
    // (1500 / 1000) * 2 = 3 units * 0.30 = 0.90
    expect(el?.units).toBeCloseTo(3, 4);
    expect(el?.subtotal).toBeCloseTo(0.9, 4);
  });

  it("scales Anthropic with estimated_chat_iterations", () => {
    const result = estimatePipelineCost({
      format: "image",
      picked_image_count: 1,
      picked_video_count: 0,
      estimated_chat_iterations: 3,
    });

    const anthropic = result.items.find((i) => i.api === "Anthropic");
    expect(anthropic?.units).toBe(3);
    expect(anthropic?.subtotal).toBeCloseTo(3 * ANTHROPIC_PER_ITER, 4);
  });

  it("image-only ignores picked_video_count", () => {
    const result = estimatePipelineCost({
      format: "image",
      picked_image_count: 1,
      picked_video_count: 5,
    });

    expect(result.items.map((i) => i.api)).not.toContain("ElevenLabs");
    expect(result.items.map((i) => i.api)).not.toContain("Submagic");
  });
});
