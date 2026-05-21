import { describe, expect, it } from "vitest";

import type { Approval } from "./types";
import { approvalTitle, describeApproval, humanizeToolName } from "./describe";

function makeApproval(overrides: Partial<Approval> = {}): Approval {
  return {
    id: "a1",
    ekko_session_id: "session-1",
    ekko_tool_call_id: "tc-1",
    tool_name: "shell_exec",
    tool_args: {},
    risk_class: "unknown",
    context: null,
    requested_at: "2026-05-18T10:00:00Z",
    expires_at: "2026-05-18T10:05:00Z",
    status: "pending",
    decision: null,
    decided_by: null,
    decided_at: null,
    decision_notes: null,
    cache_for_session: null,
    cache_for_minutes: null,
    worker_received_at: null,
    ...overrides,
  };
}

const RENDER_TOOL = "mcp_pipeline_operator_pipeline_operator_render";

describe("describeApproval", () => {
  it("describes a concept_preview render with N items", () => {
    const a = makeApproval({
      tool_name: RENDER_TOOL,
      tool_args: { pipeline_id: "p1", kind: "concept_preview", items: [1, 2, 3] },
    });
    expect(describeApproval(a).purpose).toBe("Render 3 concept previews");
  });

  it("singularises the concept_preview render when there is one item", () => {
    const a = makeApproval({
      tool_name: RENDER_TOOL,
      tool_args: { pipeline_id: "p1", kind: "concept_preview", items: [1] },
    });
    expect(describeApproval(a).purpose).toBe("Render 1 concept preview");
  });

  it("describes a final render with N items", () => {
    const a = makeApproval({
      tool_name: RENDER_TOOL,
      tool_args: { pipeline_id: "p1", kind: "final", items: [1, 2] },
    });
    expect(describeApproval(a).purpose).toBe("Render 2 final images");
  });

  it("defaults the render kind to concept_preview when absent", () => {
    const a = makeApproval({
      tool_name: RENDER_TOOL,
      tool_args: { pipeline_id: "p1", items: [1] },
    });
    expect(describeApproval(a).purpose).toBe("Render 1 concept preview");
  });

  it("describes a kie_generate call with a truncated prompt detail", () => {
    const prompt = "A".repeat(200);
    const a = makeApproval({
      tool_name: "kie_generate",
      tool_args: { prompt, size: "1024x1024", n: 1, quality: "high" },
      context: { pipeline_id: "p1", estimated_cost: 0.04 },
    });
    const desc = describeApproval(a);
    expect(desc.purpose).toBe("Generate image");
    expect(desc.detail.length).toBeLessThanOrEqual(120);
    expect(desc.detail.endsWith("…")).toBe(true);
  });

  it("keeps a short kie_generate prompt intact", () => {
    const a = makeApproval({
      tool_name: "kie_generate",
      tool_args: { prompt: "a red bicycle", size: "1024x1024", n: 1 },
    });
    expect(describeApproval(a).detail).toBe("a red bicycle");
  });

  it("falls back to a humanised tool name for unknown tools", () => {
    const a = makeApproval({ tool_name: "shell_exec" });
    expect(describeApproval(a).purpose).toBe("Shell exec");
  });
});

describe("humanizeToolName", () => {
  it("strips the mcp_ prefix and splits on underscores", () => {
    expect(humanizeToolName("mcp_send_message")).toBe("Send message");
  });

  it("splits camelCase", () => {
    expect(humanizeToolName("createBriefDraft")).toBe("Create Brief Draft");
  });
});

describe("approvalTitle", () => {
  it("renders 'Client — Purpose' when client_name is set", () => {
    const a = makeApproval({
      tool_name: "kie_generate",
      tool_args: { prompt: "x" },
      client_name: "Acme Co",
    });
    expect(approvalTitle(a)).toBe("Acme Co — Generate image");
  });

  it("falls back to the skill name when client_name is null", () => {
    const a = makeApproval({
      tool_name: "kie_generate",
      tool_args: { prompt: "x" },
      client_name: null,
      context: { skill_name: "image-skill" },
    });
    expect(approvalTitle(a)).toBe("image-skill — Generate image");
  });

  it("falls back to the session id when neither client nor skill is set", () => {
    const a = makeApproval({
      tool_name: "kie_generate",
      tool_args: { prompt: "x" },
      ekko_session_id: "sess-9",
    });
    expect(approvalTitle(a)).toBe("sess-9 — Generate image");
  });
});
