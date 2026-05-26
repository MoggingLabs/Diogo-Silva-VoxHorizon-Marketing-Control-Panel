/**
 * Tests for the work-queue freshness helpers (silent-failure PR-2a).
 *
 * Pure functions only — no DB, no realtime. Covers the daemon freshness
 * derivation across all five consumer statuses + the heartbeat-staleness
 * threshold + the per-kind label map.
 */
import { describe, expect, it } from "vitest";

import { DAEMON_STALE_THRESHOLD_S, WORK_ITEM_KIND_LABEL, deriveDaemonFreshness } from "./freshness";
import type { WorkItemConsumer, WorkItemKind } from "./types";

function consumer(overrides: Partial<WorkItemConsumer> = {}): WorkItemConsumer {
  return {
    id: "operator-daemon-1",
    kind: "operator_dispatch",
    status: "live",
    startup_check: null,
    last_seen_at: new Date("2026-05-26T12:00:00Z").toISOString(),
    image_tag: "operator:1.2.3",
    hostname: "operator-1",
    created_at: new Date("2026-05-26T11:00:00Z").toISOString(),
    updated_at: new Date("2026-05-26T12:00:00Z").toISOString(),
    ...overrides,
  };
}

describe("deriveDaemonFreshness", () => {
  const now = new Date("2026-05-26T12:00:00Z");

  it("returns 'down' when no consumer row exists yet", () => {
    expect(deriveDaemonFreshness(null, now)).toBe("down");
  });

  it("returns 'down' for an explicit consumer.status='down'", () => {
    expect(deriveDaemonFreshness(consumer({ status: "down" }), now)).toBe("down");
  });

  it("returns 'down' for a cleanly-shutdown daemon (status='stopped')", () => {
    expect(deriveDaemonFreshness(consumer({ status: "stopped" }), now)).toBe("down");
  });

  it("returns 'starting' while the daemon is booting (status='starting')", () => {
    expect(deriveDaemonFreshness(consumer({ status: "starting" }), now)).toBe("starting");
  });

  it("returns 'stale' for a degraded daemon (status='degraded')", () => {
    expect(deriveDaemonFreshness(consumer({ status: "degraded" }), now)).toBe("stale");
  });

  it("returns 'live' when heartbeat is fresh", () => {
    expect(
      deriveDaemonFreshness(
        consumer({
          status: "live",
          last_seen_at: new Date("2026-05-26T11:59:30Z").toISOString(),
        }),
        now,
      ),
    ).toBe("live");
  });

  it("returns 'stale' when last_seen_at is older than the threshold", () => {
    // 5 minutes old, way over the 60s default.
    expect(
      deriveDaemonFreshness(
        consumer({
          status: "live",
          last_seen_at: new Date("2026-05-26T11:55:00Z").toISOString(),
        }),
        now,
      ),
    ).toBe("stale");
  });

  it("returns 'down' if last_seen_at is unparseable", () => {
    expect(
      deriveDaemonFreshness(
        consumer({
          status: "live",
          last_seen_at: "not-a-date",
        }),
        now,
      ),
    ).toBe("down");
  });

  it("respects a custom threshold", () => {
    // 30s old, threshold=10s -> stale.
    expect(
      deriveDaemonFreshness(
        consumer({
          status: "live",
          last_seen_at: new Date("2026-05-26T11:59:30Z").toISOString(),
        }),
        now,
        10,
      ),
    ).toBe("stale");
  });

  it("exposes a sensible default threshold", () => {
    expect(DAEMON_STALE_THRESHOLD_S).toBeGreaterThan(15);
    expect(DAEMON_STALE_THRESHOLD_S).toBeLessThan(300);
  });
});

describe("WORK_ITEM_KIND_LABEL", () => {
  const allKinds: WorkItemKind[] = [
    "operator_dispatch",
    "outbox_meta_record_launch",
    "outbox_drive_finalize_verified",
    "outbox_ghl_send",
    "kie_video_render",
    "kie_image_render",
    "kie_tts",
    "ffmpeg_compose",
    "worker_ideation",
    "worker_generation",
    "worker_monitor",
    "broll_search",
    "other",
  ];

  it("registers a label + description for every work_item_kind", () => {
    for (const kind of allKinds) {
      const entry = WORK_ITEM_KIND_LABEL[kind];
      expect(entry).toBeTruthy();
      expect(entry.label.length).toBeGreaterThan(0);
      expect(entry.description.length).toBeGreaterThan(0);
    }
  });
});
