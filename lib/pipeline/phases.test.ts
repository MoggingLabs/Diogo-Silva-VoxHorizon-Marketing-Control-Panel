import { describe, expect, it } from "vitest";

import { PIPELINE_PHASES, phaseForStatus, stageClass } from "./phases";
import { PIPELINE_STAGES, type PipelineStatus } from "./types";

const ALL_STATUSES: PipelineStatus[] = [...PIPELINE_STAGES.map((s) => s.key), "cancelled"];

describe("PIPELINE_PHASES", () => {
  it("covers every status exactly once across the phases", () => {
    const seen = PIPELINE_PHASES.flatMap((p) => p.stages);
    expect([...seen].sort()).toEqual([...ALL_STATUSES].sort());
    expect(new Set(seen).size).toBe(seen.length); // no dupes
  });

  it("maps representative stages to the right phase", () => {
    expect(phaseForStatus("configuration")).toBe("define");
    expect(phaseForStatus("generation")).toBe("create");
    expect(phaseForStatus("compliance_review")).toBe("vet");
    expect(phaseForStatus("copy")).toBe("vet");
    expect(phaseForStatus("finalize_assets")).toBe("pack");
    expect(phaseForStatus("launch_handoff")).toBe("live");
    expect(phaseForStatus("done")).toBe("closed");
    expect(phaseForStatus("cancelled")).toBe("closed");
  });
});

describe("stageClass", () => {
  it("classifies every status (no unclassified stage)", () => {
    for (const s of ALL_STATUSES) expect(stageClass(s)).toBeTruthy();
  });

  it("flags the hard gates + auto + terminal correctly", () => {
    expect(stageClass("compliance_review")).toBe("hard_gate");
    expect(stageClass("launch_handoff")).toBe("hard_gate");
    expect(stageClass("creative_qa")).toBe("per_creative");
    expect(stageClass("copy")).toBe("per_creative");
    expect(stageClass("spec_validation")).toBe("auto");
    expect(stageClass("finalize_assets")).toBe("auto");
    expect(stageClass("generation")).toBe("agent_work");
    expect(stageClass("configuration")).toBe("human_gate");
    expect(stageClass("done")).toBe("terminal");
    expect(stageClass("cancelled")).toBe("terminal");
  });
});
