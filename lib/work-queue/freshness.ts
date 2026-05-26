/**
 * Silent-failure PR-2a: pure helpers for the dashboard read surfaces.
 *
 * Kept separate from `./types.ts` (which holds type aliases only) so the
 * coverage report tracks this logic instead of excluding it under the
 * project-wide `**\/types.ts` pattern in `vitest.config.ts`.
 */

import type { DaemonFreshness, WorkItemConsumer, WorkItemKind } from "./types";

/**
 * Default threshold (in seconds) past which a consumer's `last_seen_at` is
 * considered stale. The operator daemon heartbeats every 15s in PR-3; 60s
 * gives three missed beats before the badge turns yellow.
 */
export const DAEMON_STALE_THRESHOLD_S = 60;

/**
 * Derive the badge freshness from a consumer row + the current clock. Used
 * by both useDaemonHealth (client) and DaemonHealthBadge (rendering).
 *
 * Pure: takes a consumer (or null) + a Date; returns one of four strings.
 * Exporting + unit-testing keeps the staleness arithmetic in one place.
 */
export function deriveDaemonFreshness(
  consumer: WorkItemConsumer | null,
  now: Date = new Date(),
  thresholdSeconds: number = DAEMON_STALE_THRESHOLD_S,
): DaemonFreshness {
  if (!consumer) return "down";
  if (consumer.status === "down" || consumer.status === "stopped") return "down";
  if (consumer.status === "starting") return "starting";
  if (consumer.status === "degraded") return "stale";

  // status === "live"; check the heartbeat freshness.
  const lastSeen = Date.parse(consumer.last_seen_at);
  if (Number.isNaN(lastSeen)) return "down";
  const ageSeconds = (now.getTime() - lastSeen) / 1000;
  if (ageSeconds > thresholdSeconds) return "stale";
  return "live";
}

/**
 * Per-kind label/description map driving the WorkItemPanel header. Kept tiny
 * and centralised so a new `work_item_kind` registers with one line, not by
 * editing every place the panel renders.
 */
export const WORK_ITEM_KIND_LABEL: Record<WorkItemKind, { label: string; description: string }> = {
  operator_dispatch: {
    label: "Operator dispatch",
    description: "Hermes is running the next stage in the operator daemon.",
  },
  outbox_meta_record_launch: {
    label: "Meta launch record",
    description: "Persisting the Meta launch outcome to the integration log.",
  },
  outbox_drive_finalize_verified: {
    label: "Drive finalize verify",
    description: "Verifying the finalize-assets folder mirror in Google Drive.",
  },
  outbox_ghl_send: {
    label: "GHL contact sync",
    description: "Forwarding the lead handoff to Go High Level.",
  },
  kie_video_render: {
    label: "Video render",
    description: "Kie.ai is rendering the video creative.",
  },
  kie_image_render: {
    label: "Image render",
    description: "Kie.ai is rendering the image creative.",
  },
  kie_tts: {
    label: "Voiceover synthesis",
    description: "Kie.ai is synthesising the voiceover audio.",
  },
  ffmpeg_compose: {
    label: "Video compose",
    description: "ffmpeg is composing the final video from b-roll + voiceover.",
  },
  worker_ideation: {
    label: "Ideation",
    description: "The worker is generating concept ideas from the brief.",
  },
  worker_generation: {
    label: "Generation",
    description: "The worker is generating creatives from the approved brief.",
  },
  worker_monitor: {
    label: "Monitor pull",
    description: "The worker is pulling live campaign performance from Meta + GHL.",
  },
  broll_search: {
    label: "B-roll search",
    description: "Searching the b-roll library for matching clips.",
  },
  other: {
    label: "Background task",
    description: "A queued background task is in progress.",
  },
};
