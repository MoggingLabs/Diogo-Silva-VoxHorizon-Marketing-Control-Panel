import { describe, expect, it } from "vitest";

import {
  NOTIFICATION_KINDS,
  labelForKind,
  pushBodyFromPayload,
  type NotificationPayload,
} from "./notifications";

describe("NOTIFICATION_KINDS / labelForKind", () => {
  it("exposes the canonical kind list", () => {
    expect(NOTIFICATION_KINDS).toContain("brief_awaits_approval");
    expect(NOTIFICATION_KINDS).toContain("worker_job_failed");
  });

  it("maps known kinds to human labels", () => {
    expect(labelForKind("brief_awaits_approval")).toBe("Brief awaiting approval");
    expect(labelForKind("creative_fatigue")).toBe("Creative fatigue alert");
    expect(labelForKind("kill_threshold")).toBe("Kill threshold reached");
    expect(labelForKind("launch_approved")).toBe("Launch approved");
    expect(labelForKind("worker_job_failed")).toBe("Worker job failed");
  });

  it("falls back to the raw kind string for unknown kinds", () => {
    expect(labelForKind("custom_event")).toBe("custom_event");
  });
});

describe("pushBodyFromPayload", () => {
  it("formats brief_awaits_approval", () => {
    const payload: NotificationPayload = {
      kind: "brief_awaits_approval",
      briefId: "b1",
      briefIdHuman: "br-1",
      clientName: "Acme",
      format: "image",
      url: "/briefs/b1",
    };
    expect(pushBodyFromPayload(payload)).toEqual({
      kind: "brief_awaits_approval",
      title: "Brief br-1 awaiting approval",
      body: "Acme • image",
      url: "/briefs/b1",
    });
  });

  it("formats creative_fatigue", () => {
    const out = pushBodyFromPayload({
      kind: "creative_fatigue",
      campaignId: "c1",
      campaignName: "Camp",
      clientName: "Acme",
      spend: 10,
      ctr: 0.01,
      freq: 3,
      reason: "burnt out",
      url: "/audit",
    });
    expect(out.title).toMatch(/Camp/);
    expect(out.body).toBe("burnt out");
  });

  it("formats kill_threshold", () => {
    const out = pushBodyFromPayload({
      kind: "kill_threshold",
      campaignId: "c1",
      campaignName: "Camp",
      clientName: "Acme",
      spend: 100,
      leads: 0,
      reason: "no leads",
      url: "/audit",
    });
    expect(out.title).toMatch(/Kill/);
    expect(out.body).toBe("no leads");
  });

  it("formats launch_approved", () => {
    const out = pushBodyFromPayload({
      kind: "launch_approved",
      launchId: "l1",
      briefIdHuman: "br-1",
      clientName: "Acme",
      format: "video",
      url: "/launches/l1",
    });
    expect(out.title).toMatch(/Launch approved.*br-1/);
    expect(out.body).toBe("Acme • video");
  });

  it("formats worker_job_failed", () => {
    const out = pushBodyFromPayload({
      kind: "worker_job_failed",
      job: "pull-perf",
      error: "timeout",
      url: "/settings",
    });
    expect(out.title).toBe("Worker job failed: pull-perf");
    expect(out.body).toBe("timeout");
  });
});
