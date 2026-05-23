import { describe, expect, it } from "vitest";

import {
  LaunchDecisionInput,
  MonitorDecisionInput,
  VariantPlanDecisionInput,
} from "./decision-schemas";

describe("VariantPlanDecisionInput", () => {
  it("approves without notes", () => {
    expect(VariantPlanDecisionInput.safeParse({ decision: "approved" }).success).toBe(true);
  });
  it("rejects require notes", () => {
    expect(VariantPlanDecisionInput.safeParse({ decision: "rejected" }).success).toBe(false);
    expect(VariantPlanDecisionInput.safeParse({ decision: "rejected", notes: "x" }).success).toBe(
      true,
    );
  });
});

describe("LaunchDecisionInput", () => {
  it("approves only with both confirmations", () => {
    expect(
      LaunchDecisionInput.safeParse({
        decision: "approved",
        confirm_paused_first: true,
        acknowledge_preconditions: true,
      }).success,
    ).toBe(true);
  });

  it("rejects approve missing paused-first", () => {
    expect(
      LaunchDecisionInput.safeParse({ decision: "approved", acknowledge_preconditions: true })
        .success,
    ).toBe(false);
  });

  it("rejects approve missing precondition ack", () => {
    expect(
      LaunchDecisionInput.safeParse({ decision: "approved", confirm_paused_first: true }).success,
    ).toBe(false);
  });

  it("reject requires notes", () => {
    expect(LaunchDecisionInput.safeParse({ decision: "rejected" }).success).toBe(false);
    expect(LaunchDecisionInput.safeParse({ decision: "rejected", notes: "hold" }).success).toBe(
      true,
    );
  });
});

describe("MonitorDecisionInput", () => {
  it("accepts kill / scale", () => {
    expect(MonitorDecisionInput.safeParse({ decision: "kill" }).success).toBe(true);
    expect(
      MonitorDecisionInput.safeParse({ decision: "scale", campaign_id: "c1", notes: "go" }).success,
    ).toBe(true);
  });
  it("rejects an unknown decision", () => {
    expect(MonitorDecisionInput.safeParse({ decision: "pause" }).success).toBe(false);
  });
});
