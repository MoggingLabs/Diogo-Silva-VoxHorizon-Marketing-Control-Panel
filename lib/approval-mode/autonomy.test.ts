import { describe, expect, it } from "vitest";

import { canAutoAdvance, isHardGate, resolveAutonomy } from "./autonomy";

describe("resolveAutonomy — hard gates never auto-pass", () => {
  it.each(["compliance_review", "launch_handoff"] as const)(
    "%s is never auto, even under AUTO_APPROVE",
    (status) => {
      const d = resolveAutonomy("AUTO_APPROVE", status);
      expect(d.hardGate).toBe(true);
      expect(d.autoAllowed).toBe(false);
    },
  );

  it("HALT blocks every non-hard gate", () => {
    expect(resolveAutonomy("HALT", "creative_qa").autoAllowed).toBe(false);
  });

  it("AUTO_APPROVE allows non-hard gates", () => {
    const d = resolveAutonomy("AUTO_APPROVE", "creative_qa");
    expect(d.autoAllowed).toBe(true);
    expect(d.hardGate).toBe(false);
  });

  it("ASK never auto-advances", () => {
    expect(resolveAutonomy("ASK", "spec_validation").autoAllowed).toBe(false);
  });

  it("HALT on a hard gate still reports hardGate (hard takes precedence)", () => {
    const d = resolveAutonomy("HALT", "compliance_review");
    expect(d.hardGate).toBe(true);
    expect(d.autoAllowed).toBe(false);
  });
});

describe("canAutoAdvance", () => {
  it("mirrors resolveAutonomy.autoAllowed", () => {
    expect(canAutoAdvance("AUTO_APPROVE", "copy")).toBe(true);
    expect(canAutoAdvance("AUTO_APPROVE", "compliance_review")).toBe(false);
    expect(canAutoAdvance("ASK", "copy")).toBe(false);
  });
});

describe("isHardGate", () => {
  it("is true only for compliance + launch", () => {
    expect(isHardGate("compliance_review")).toBe(true);
    expect(isHardGate("launch_handoff")).toBe(true);
    expect(isHardGate("creative_qa")).toBe(false);
    expect(isHardGate("copy")).toBe(false);
  });
});
