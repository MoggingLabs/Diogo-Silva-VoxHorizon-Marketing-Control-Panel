/**
 * Centralised pricing constants for the third-party APIs the pipeline
 * spends money on. Update these as vendor pricing shifts; downstream
 * estimators read from `PRICING` so a single edit propagates everywhere.
 *
 * Units are documented per-key — keep them stable, since `cost-estimator`
 * pins consumers to these exact shapes via `as const`.
 *
 * This is the TypeScript half of the single pricing source of truth (E4.2).
 * The Python worker mirrors these exact per-unit figures in
 * `worker/src/services/pricing.py` so the estimate the manager sees on the
 * dashboard and the cost the worker records reconcile. A vendor price change
 * edits BOTH files together (the values are asserted equal on each side).
 */
export const PRICING = {
  /** Kie.ai image generation, billed per output image (per ratio). */
  kie_ai: { per_image: 0.05 },
  /** Kie video generation (Veo Fast tier), billed per generated clip. */
  kie_video: { per_clip: 0.4 },
  /** ElevenLabs TTS, billed per 1,000 characters of script. */
  elevenlabs: { per_1k_chars: 0.3 },
  /** Submagic clip post-processing, billed per finished video. */
  submagic: { per_video: 1.0 },
  /** Anthropic Claude pricing per million tokens (Sonnet 4.x tier). */
  anthropic: { per_million_input: 3.0, per_million_output: 15.0 },
  /** Hyperframes — currently bundled, zero marginal cost per video. */
  hyperframes: { per_video: 0.0 },
  /** yt-dlp clip download — local, zero marginal cost. */
  yt_dlp: { per_clip: 0.0 },
} as const;
