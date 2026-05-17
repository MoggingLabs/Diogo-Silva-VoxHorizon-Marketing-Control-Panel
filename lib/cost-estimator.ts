import type { PipelineFormat } from "./pipeline/types";
import { activeTracks } from "./pipeline/tracks";
import { PRICING } from "./pricing";

/** One line item in a cost estimate. */
export type EstimateItem = {
  /** Human-readable API label, e.g. "Kie.ai". */
  api: string;
  /** Unit description for the table, e.g. "image", "1k chars". */
  unit_label: string;
  /** Quantity of `unit_label` consumed. */
  units: number;
  /** USD cost per unit. */
  unit_cost: number;
  /** USD subtotal (`units * unit_cost`). */
  subtotal: number;
};

/** Aggregate estimate: line items + grand total. */
export type Estimate = {
  items: EstimateItem[];
  total: number;
};

/** Inputs to `estimatePipelineCost`. Counts default to zero where omitted. */
export type EstimateInput = {
  format: PipelineFormat;
  picked_image_count: number;
  picked_video_count: number;
  /** Average characters per video script. Default 800. */
  estimated_script_chars?: number;
  /** B-roll clips downloaded per video (currently zero-cost). Default 4. */
  estimated_broll_clips?: number;
  /** Total Claude chat iterations across the pipeline. Default 1. */
  estimated_chat_iterations?: number;
};

/** Per-ratio multiplier for image generation (1:1 + 9:16). */
const IMAGE_RATIO_COUNT = 2;
/** Token budget per Claude iteration, used for Anthropic line. */
const ANTHROPIC_INPUT_TOKENS_PER_ITER = 100_000;
const ANTHROPIC_OUTPUT_TOKENS_PER_ITER = 5_000;

/**
 * Pure cost estimator. Emits one row per API that contributes non-zero
 * cost, summed across active tracks. Zero-cost APIs (Hyperframes, yt-dlp)
 * are omitted to keep the breakdown table readable.
 *
 * The shape is stable — same inputs always produce identical output, in
 * a documented order: Kie.ai, ElevenLabs, Submagic, Anthropic.
 */
export function estimatePipelineCost(input: EstimateInput): Estimate {
  const {
    format,
    picked_image_count,
    picked_video_count,
    estimated_script_chars = 800,
    estimated_chat_iterations = 1,
  } = input;

  const tracks = activeTracks(format);
  const imageActive = tracks.includes("image");
  const videoActive = tracks.includes("video");

  const items: EstimateItem[] = [];

  // Kie.ai — image generation, 2 ratios per pick (1:1 + 9:16).
  if (imageActive && picked_image_count > 0) {
    const units = picked_image_count * IMAGE_RATIO_COUNT;
    const unit_cost = PRICING.kie_ai.per_image;
    items.push({
      api: "Kie.ai",
      unit_label: "image",
      units,
      unit_cost,
      subtotal: round(units * unit_cost),
    });
  }

  // ElevenLabs — TTS per 1k chars × picked videos.
  if (videoActive && picked_video_count > 0) {
    const units = round((estimated_script_chars / 1000) * picked_video_count);
    const unit_cost = PRICING.elevenlabs.per_1k_chars;
    items.push({
      api: "ElevenLabs",
      unit_label: "1k chars",
      units,
      unit_cost,
      subtotal: round(units * unit_cost),
    });
  }

  // Submagic — per finished video.
  if (videoActive && picked_video_count > 0) {
    const units = picked_video_count;
    const unit_cost = PRICING.submagic.per_video;
    items.push({
      api: "Submagic",
      unit_label: "video",
      units,
      unit_cost,
      subtotal: round(units * unit_cost),
    });
  }

  // Anthropic — Claude chat iterations driving the pipeline.
  if (estimated_chat_iterations > 0) {
    const units = estimated_chat_iterations;
    const per_iter_cost =
      (ANTHROPIC_INPUT_TOKENS_PER_ITER / 1_000_000) * PRICING.anthropic.per_million_input +
      (ANTHROPIC_OUTPUT_TOKENS_PER_ITER / 1_000_000) * PRICING.anthropic.per_million_output;
    items.push({
      api: "Anthropic",
      unit_label: "iteration",
      units,
      unit_cost: round(per_iter_cost),
      subtotal: round(units * per_iter_cost),
    });
  }

  // If nothing was picked or activated, drop the Anthropic-only line so
  // the empty state stays empty.
  const anyTrackUnits =
    (imageActive && picked_image_count > 0) || (videoActive && picked_video_count > 0);
  const finalItems = anyTrackUnits ? items : [];

  const total = round(finalItems.reduce((acc, item) => acc + item.subtotal, 0));
  return { items: finalItems, total };
}

/** Round to 4 decimal places to keep floating point noise out of totals. */
function round(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}
