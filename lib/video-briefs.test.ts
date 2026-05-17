import { describe, expect, it } from "vitest";

import {
  APPROVING_DECISIONS,
  BrollSelectionMode,
  CaptionsStyle,
  Decision,
  DecisionInput,
  HookStyle,
  Ratio,
  ScriptOutline,
  ScriptSegment,
  VideoBriefInput,
  VideoBriefPatchInput,
  VideoBriefStatus,
  allowedTransitions,
  canTransition,
  totalSegmentDuration,
} from "./video-briefs";

describe("video-briefs enums", () => {
  it("VideoBriefStatus + Ratio + HookStyle + CaptionsStyle + BrollSelectionMode accept canonical literals", () => {
    expect(VideoBriefStatus.safeParse("draft").success).toBe(true);
    expect(Ratio.safeParse("9x16").success).toBe(true);
    expect(HookStyle.safeParse("curiosity").success).toBe(true);
    expect(CaptionsStyle.safeParse("bold_yellow").success).toBe(true);
    expect(BrollSelectionMode.safeParse("auto").success).toBe(true);
  });
});

describe("ScriptSegment / ScriptOutline", () => {
  it("ScriptSegment requires a positive duration", () => {
    expect(ScriptSegment.safeParse({ topic: "Intro", duration_s: 5 }).success).toBe(true);
    expect(ScriptSegment.safeParse({ topic: "x", duration_s: -1 }).success).toBe(false);
  });

  it("ScriptOutline requires hook + at least one segment", () => {
    expect(
      ScriptOutline.safeParse({
        hook: "Hello there",
        segments: [{ topic: "Intro", duration_s: 5 }],
      }).success,
    ).toBe(true);

    expect(ScriptOutline.safeParse({ hook: "hi", segments: [] }).success).toBe(false);
  });
});

describe("VideoBriefInput", () => {
  const base = {
    client_id: "11111111-1111-4111-8111-111111111111",
    script_outline: {
      hook: "Hello there friend",
      segments: [
        { topic: "Intro", duration_s: 5 },
        { topic: "Body", duration_s: 10 },
      ],
    },
    target_duration_s: 15,
    voice_id: "bran",
    dimensions: "9x16" as const,
  };

  it("accepts a clean input", () => {
    expect(VideoBriefInput.safeParse(base).success).toBe(true);
  });

  it("rejects when segments don't sum to target duration", () => {
    expect(
      VideoBriefInput.safeParse({
        ...base,
        target_duration_s: 30,
      }).success,
    ).toBe(false);
  });

  it("rejects an over-cap duration", () => {
    expect(
      VideoBriefInput.safeParse({
        ...base,
        target_duration_s: 200,
        script_outline: {
          ...base.script_outline,
          segments: [
            { topic: "x", duration_s: 100 },
            { topic: "y", duration_s: 100 },
          ],
        },
      }).success,
    ).toBe(false);
  });

  it("requires a uuid client_id", () => {
    expect(VideoBriefInput.safeParse({ ...base, client_id: "not-a-uuid" }).success).toBe(false);
  });

  it("applies default dimensions=9x16", () => {
    const noDims = { ...base } as Partial<typeof base>;
    delete (noDims as { dimensions?: unknown }).dimensions;
    const parsed = VideoBriefInput.parse(noDims as never);
    expect(parsed.dimensions).toBe("9x16");
  });
});

describe("VideoBriefPatchInput", () => {
  it("accepts an empty patch", () => {
    expect(VideoBriefPatchInput.safeParse({}).success).toBe(true);
  });

  it("accepts a single-field patch", () => {
    expect(VideoBriefPatchInput.safeParse({ voice_id: "alice" }).success).toBe(true);
  });

  it("enforces the duration cross-check when both fields are present", () => {
    expect(
      VideoBriefPatchInput.safeParse({
        target_duration_s: 30,
        script_outline: {
          hook: "Hello there",
          segments: [{ topic: "Intro", duration_s: 30 }],
        },
      }).success,
    ).toBe(true);

    expect(
      VideoBriefPatchInput.safeParse({
        target_duration_s: 30,
        script_outline: {
          hook: "Hello there",
          segments: [{ topic: "Intro", duration_s: 5 }],
        },
      }).success,
    ).toBe(false);
  });

  it("skips the cross-check when only one field is set", () => {
    expect(
      VideoBriefPatchInput.safeParse({
        target_duration_s: 30,
      }).success,
    ).toBe(true);
  });
});

describe("DecisionInput", () => {
  it("notes required for non-approved decisions", () => {
    expect(DecisionInput.safeParse({ decision: "approved" }).success).toBe(true);
    expect(DecisionInput.safeParse({ decision: "rejected" }).success).toBe(false);
    expect(DecisionInput.safeParse({ decision: "rejected", notes: "bad" }).success).toBe(true);
  });

  it("Decision enum accepts the three approval values", () => {
    expect(Decision.safeParse("approved").success).toBe(true);
    expect(Decision.safeParse("posted").success).toBe(false);
  });
});

describe("canTransition / allowedTransitions", () => {
  it("matches the state-machine table", () => {
    expect(canTransition("draft", "posted")).toBe(true);
    expect(canTransition("approved", "draft")).toBe(false);
    expect(canTransition("rejected", "draft")).toBe(true);
    expect(allowedTransitions.approved).toEqual([]);
  });
});

describe("totalSegmentDuration / APPROVING_DECISIONS", () => {
  it("sums segments", () => {
    expect(
      totalSegmentDuration([
        { topic: "a", duration_s: 1 },
        { topic: "b", duration_s: 2 },
      ]),
    ).toBe(3);
  });

  it("approving decisions include the two approvals", () => {
    expect(APPROVING_DECISIONS).toContain("approved");
    expect(APPROVING_DECISIONS).toContain("approved_with_changes");
  });
});
