import { describe, expect, it, vi } from "vitest";

// `lib/operator/dispatch.ts` imports `server-only`; neutralise it so the node
// test project can import the module under test.
vi.mock("server-only", () => ({}));

import { isOperatorDriven, operatorInstruction, type OperatorStage } from "./dispatch";

const PIPELINE = "11111111-1111-4111-8111-111111111111";

describe("operatorInstruction", () => {
  it("embeds the manager brief on the configuration kickoff", () => {
    const out = operatorInstruction("configuration", PIPELINE, "4 roofing ads, Austin");
    expect(out).toContain(PIPELINE);
    expect(out).toContain("4 roofing ads, Austin");
    expect(out.toLowerCase()).toContain("review");
  });

  it("falls back to a generic configuration ask without a brief", () => {
    const out = operatorInstruction("configuration", PIPELINE);
    expect(out).toContain(PIPELINE);
    expect(out.toLowerCase()).toContain("brief");
  });

  it("asks for concepts at ideation and finals at generation", () => {
    expect(operatorInstruction("ideation", PIPELINE).toLowerCase()).toContain("concept");
    expect(operatorInstruction("generation", PIPELINE).toLowerCase()).toContain("final");
  });

  it("tells the operator to stand by during review", () => {
    expect(operatorInstruction("review", PIPELINE).toLowerCase()).toContain("stand by");
  });

  it("returns a pipeline-scoped, on-topic instruction for every downstream gate stage", () => {
    const cases: Array<[OperatorStage, RegExp]> = [
      ["creative_qa", /qa/i],
      ["compliance_review", /ruleset|block/i],
      ["copy", /copy/i],
      ["spec_validation", /spec|crop/i],
      ["variant_plan", /matrix|a\/b/i],
      ["finalize_assets", /finalize|drive/i],
      ["launch_handoff", /launch|paused/i],
      ["monitor", /monitor|lead/i],
    ];
    for (const [stage, keyword] of cases) {
      const out = operatorInstruction(stage, PIPELINE);
      expect(out).toContain(PIPELINE);
      expect(out).toMatch(keyword);
    }
  });
});

describe("isOperatorDriven", () => {
  it("is true when config_draft.operator_driven is true", () => {
    expect(isOperatorDriven({ operator_driven: true })).toBe(true);
  });

  it("is true when a non-empty operator_instruction is present (legacy rows)", () => {
    expect(isOperatorDriven({ operator_instruction: "4 roofing ads" })).toBe(true);
  });

  it("is false for a regular pipeline draft", () => {
    expect(isOperatorDriven({ image_payload: { market: "Austin" } })).toBe(false);
  });

  it("is false for empty / blank / non-object drafts", () => {
    expect(isOperatorDriven(null)).toBe(false);
    expect(isOperatorDriven(undefined)).toBe(false);
    expect(isOperatorDriven({})).toBe(false);
    expect(isOperatorDriven({ operator_instruction: "   " })).toBe(false);
    expect(isOperatorDriven([])).toBe(false);
    expect(isOperatorDriven("nope")).toBe(false);
  });
});
