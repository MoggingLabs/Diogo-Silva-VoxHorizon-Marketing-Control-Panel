import type { PipelineFormat } from "./types";

/**
 * The two media tracks a pipeline can produce. A `PipelineFormat` of
 * `"both"` activates both tracks; `"image"` / `"video"` activate the
 * single matching track.
 */
export type PipelineTrack = "image" | "video";

/**
 * Returns the list of tracks active for the given format choice. Stable
 * order: `image` then `video` when both are active.
 */
export function activeTracks(format: PipelineFormat): PipelineTrack[] {
  if (format === "both") return ["image", "video"];
  return [format];
}

/**
 * Convenience predicate — true iff `track` is active under `format`.
 */
export function isTrackActive(format: PipelineFormat, track: PipelineTrack): boolean {
  return activeTracks(format).includes(track);
}
