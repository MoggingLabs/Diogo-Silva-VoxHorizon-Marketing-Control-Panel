/**
 * Extra coverage for `lib/launches.ts` beyond the existing foundation test
 * (which only exercises `LaunchInput`). Covers the decision schema, state
 * machine, issue/payload shapes, and the payload<->json helpers — together
 * these push the file from 53% to ≥90% line coverage.
 */
import { describe, expect, it } from "vitest";

import {
  LaunchDecision,
  LaunchDecisionInput,
  LaunchIssue,
  LaunchIssueSeverity,
  LaunchPayload,
  LaunchStatus,
  allowedTransitions,
  canTransitionLaunch,
  payloadToJson,
  readLaunchPayload,
} from "./launches";

describe("LaunchDecision / LaunchStatus", () => {
  it("LaunchDecision accepts the canonical three", () => {
    expect(LaunchDecision.safeParse("approved").success).toBe(true);
    expect(LaunchDecision.safeParse("approved_with_changes").success).toBe(true);
    expect(LaunchDecision.safeParse("rejected").success).toBe(true);
    expect(LaunchDecision.safeParse("failed").success).toBe(false);
  });

  it("LaunchStatus accepts each canonical status", () => {
    for (const s of [
      "validating",
      "posted",
      "approved",
      "approved_with_changes",
      "rejected",
      "failed",
    ]) {
      expect(LaunchStatus.safeParse(s).success).toBe(true);
    }
    expect(LaunchStatus.safeParse("done").success).toBe(false);
  });
});

describe("LaunchDecisionInput", () => {
  it("approved needs no notes", () => {
    expect(LaunchDecisionInput.safeParse({ decision: "approved" }).success).toBe(true);
  });

  it("approved_with_changes / rejected require non-empty notes", () => {
    expect(LaunchDecisionInput.safeParse({ decision: "rejected" }).success).toBe(false);
    expect(LaunchDecisionInput.safeParse({ decision: "rejected", notes: "  " }).success).toBe(
      false,
    );
    expect(LaunchDecisionInput.safeParse({ decision: "rejected", notes: "fix" }).success).toBe(
      true,
    );
    expect(
      LaunchDecisionInput.safeParse({
        decision: "approved_with_changes",
        notes: "tweak",
      }).success,
    ).toBe(true);
  });

  it("rejects notes over the 5000 char cap", () => {
    expect(
      LaunchDecisionInput.safeParse({
        decision: "rejected",
        notes: "x".repeat(5001),
      }).success,
    ).toBe(false);
  });
});

describe("state machine", () => {
  it("allowedTransitions reflects the doc table", () => {
    expect(allowedTransitions.validating).toContain("posted");
    expect(allowedTransitions.validating).toContain("failed");
    expect(allowedTransitions.posted).toContain("approved");
    expect(allowedTransitions.approved).toEqual([]);
    expect(allowedTransitions.failed).toEqual([]);
  });

  it("canTransitionLaunch", () => {
    expect(canTransitionLaunch("validating", "posted")).toBe(true);
    expect(canTransitionLaunch("posted", "approved")).toBe(true);
    expect(canTransitionLaunch("approved", "rejected")).toBe(false);
    // no-op transitions are allowed
    expect(canTransitionLaunch("approved", "approved")).toBe(true);
  });
});

describe("LaunchIssue / LaunchIssueSeverity / LaunchPayload", () => {
  it("severity accepts error|warning only", () => {
    expect(LaunchIssueSeverity.safeParse("error").success).toBe(true);
    expect(LaunchIssueSeverity.safeParse("warning").success).toBe(true);
    expect(LaunchIssueSeverity.safeParse("critical").success).toBe(false);
  });

  it("LaunchIssue parses with required severity + message", () => {
    expect(LaunchIssue.safeParse({ severity: "error", message: "x" }).success).toBe(true);
    expect(LaunchIssue.safeParse({ severity: "error" }).success).toBe(false);
  });

  it("LaunchPayload parses a clean payload", () => {
    const payload = LaunchPayload.safeParse({
      brief_id_human: "br-1",
      client: null,
      creative_ids: [],
      copy_variant_ids: [],
      validation: { ok: true, via: "preflight" },
    });
    expect(payload.success).toBe(true);
    if (payload.success) {
      expect(payload.data.issues).toEqual([]);
    }
  });
});

describe("readLaunchPayload / payloadToJson", () => {
  const goodPayload = {
    brief_id_human: "br-1",
    client: { id: "c", slug: "s", name: "n" },
    creative_ids: ["11111111-1111-4111-8111-111111111111"],
    copy_variant_ids: [],
    asset_refs: [],
    issues: [],
    validation: { ok: true, via: "preflight" as const },
  };

  it("round-trips a valid payload", () => {
    const json = payloadToJson(goodPayload);
    expect(readLaunchPayload({ payload: json } as never)).toEqual(goodPayload);
  });

  it("returns null when the payload is malformed", () => {
    expect(readLaunchPayload({ payload: { bogus: 1 } } as never)).toBeNull();
  });
});
