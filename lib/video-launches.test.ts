import { describe, expect, it } from "vitest";

import {
  VideoLaunchDecision,
  VideoLaunchDecisionInput,
  VideoLaunchInput,
  VideoLaunchIssue,
  VideoLaunchIssueSeverity,
  VideoLaunchPayload,
  VideoLaunchStatus,
  allowedVideoTransitions,
  canTransitionVideoLaunch,
  readVideoLaunchPayload,
  videoPayloadToJson,
} from "./video-launches";

describe("VideoLaunchInput", () => {
  it("requires a uuid brief_id", () => {
    expect(
      VideoLaunchInput.safeParse({ brief_id: "11111111-1111-4111-8111-111111111111" }).success,
    ).toBe(true);
    expect(VideoLaunchInput.safeParse({ brief_id: "nope" }).success).toBe(false);
  });
});

describe("VideoLaunchDecisionInput", () => {
  it("approved needs no notes", () => {
    expect(VideoLaunchDecisionInput.safeParse({ decision: "approved" }).success).toBe(true);
  });

  it("rejected / approved_with_changes need notes", () => {
    expect(VideoLaunchDecisionInput.safeParse({ decision: "rejected" }).success).toBe(false);
    expect(VideoLaunchDecisionInput.safeParse({ decision: "rejected", notes: "fix" }).success).toBe(
      true,
    );
    expect(
      VideoLaunchDecisionInput.safeParse({
        decision: "approved_with_changes",
        notes: "  ",
      }).success,
    ).toBe(false);
  });

  it("VideoLaunchDecision accepts canonical literals", () => {
    expect(VideoLaunchDecision.safeParse("approved").success).toBe(true);
    expect(VideoLaunchDecision.safeParse("failed").success).toBe(false);
  });
});

describe("VideoLaunchStatus + state machine", () => {
  it("status enum exposes all six values", () => {
    expect(VideoLaunchStatus.safeParse("validating").success).toBe(true);
    expect(VideoLaunchStatus.safeParse("done").success).toBe(false);
  });

  it("transitions are linear with terminal states", () => {
    expect(canTransitionVideoLaunch("validating", "posted")).toBe(true);
    expect(canTransitionVideoLaunch("posted", "approved")).toBe(true);
    expect(canTransitionVideoLaunch("approved", "rejected")).toBe(false);
    expect(canTransitionVideoLaunch("approved", "approved")).toBe(true);
    expect(allowedVideoTransitions.approved).toEqual([]);
  });
});

describe("VideoLaunchIssue / VideoLaunchPayload", () => {
  it("severity accepts error|warning only", () => {
    expect(VideoLaunchIssueSeverity.safeParse("error").success).toBe(true);
    expect(VideoLaunchIssueSeverity.safeParse("critical").success).toBe(false);
  });

  it("issue parses with required severity + message", () => {
    expect(VideoLaunchIssue.safeParse({ severity: "error", message: "x" }).success).toBe(true);
  });

  it("payload parses a clean shape", () => {
    const ok = VideoLaunchPayload.safeParse({
      brief_id_human: "vb-1",
      client: null,
      video_creative_ids: [],
      copy_variant_ids: [],
      validation: { ok: true, via: "preflight" },
    });
    expect(ok.success).toBe(true);
    if (ok.success) {
      expect(ok.data.issues).toEqual([]);
    }
  });
});

describe("readVideoLaunchPayload / videoPayloadToJson", () => {
  const payload = {
    brief_id_human: "vb-1",
    client: { id: "c", slug: "s", name: "n" },
    video_creative_ids: ["11111111-1111-4111-8111-111111111111"],
    copy_variant_ids: [],
    issues: [],
    validation: { ok: true, via: "preflight" as const },
  };

  it("roundtrips a valid payload", () => {
    const json = videoPayloadToJson(payload);
    expect(readVideoLaunchPayload({ payload: json } as never)).toEqual(payload);
  });

  it("returns null when the row's payload is malformed", () => {
    expect(readVideoLaunchPayload({ payload: { bogus: 1 } } as never)).toBeNull();
  });
});
