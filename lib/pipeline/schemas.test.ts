import { describe, expect, it } from "vitest";

import {
  CreatePipelineInput,
  ListPipelinesQuery,
  PipelineFormat,
  PipelineStatus,
  ReviewDecision,
  ReviewDecisionInput,
} from "./schemas";

describe("PipelineFormat / PipelineStatus / ReviewDecision", () => {
  it("PipelineFormat", () => {
    expect(PipelineFormat.safeParse("image").success).toBe(true);
    expect(PipelineFormat.safeParse("nope").success).toBe(false);
  });
  it("PipelineStatus", () => {
    expect(PipelineStatus.safeParse("configuration").success).toBe(true);
    expect(PipelineStatus.safeParse("nope").success).toBe(false);
  });
  it("ReviewDecision", () => {
    expect(ReviewDecision.safeParse("approved").success).toBe(true);
    expect(ReviewDecision.safeParse("nope").success).toBe(false);
  });
});

describe("CreatePipelineInput", () => {
  it("requires format_choice", () => {
    expect(CreatePipelineInput.safeParse({ format_choice: "image" }).success).toBe(true);
    expect(CreatePipelineInput.safeParse({}).success).toBe(false);
  });

  it("accepts a uuid client_id", () => {
    expect(
      CreatePipelineInput.safeParse({
        format_choice: "image",
        client_id: "11111111-1111-4111-8111-111111111111",
      }).success,
    ).toBe(true);
    expect(
      CreatePipelineInput.safeParse({
        format_choice: "image",
        client_id: "not-a-uuid",
      }).success,
    ).toBe(false);
  });
});

describe("ListPipelinesQuery", () => {
  it("applies the default limit", () => {
    const r = ListPipelinesQuery.parse({});
    expect(r.limit).toBe(50);
  });

  it("coerces the limit string to a number", () => {
    const r = ListPipelinesQuery.parse({ limit: "10" } as unknown as Record<string, string>);
    expect(r.limit).toBe(10);
  });

  it("rejects out-of-range limits", () => {
    expect(ListPipelinesQuery.safeParse({ limit: 0 } as never).success).toBe(false);
    expect(ListPipelinesQuery.safeParse({ limit: 1000 } as never).success).toBe(false);
  });

  it("validates the iso cursor", () => {
    expect(ListPipelinesQuery.safeParse({ cursor: "2026-05-17T12:00:00Z" }).success).toBe(true);
    expect(ListPipelinesQuery.safeParse({ cursor: "yesterday" }).success).toBe(false);
  });
});

describe("ReviewDecisionInput", () => {
  it("approved needs no notes", () => {
    expect(ReviewDecisionInput.safeParse({ decision: "approved" }).success).toBe(true);
  });

  it("approved_with_changes / rejected require notes", () => {
    expect(ReviewDecisionInput.safeParse({ decision: "rejected" }).success).toBe(false);
    expect(ReviewDecisionInput.safeParse({ decision: "rejected", notes: "  " }).success).toBe(
      false,
    );
    expect(ReviewDecisionInput.safeParse({ decision: "rejected", notes: "bad" }).success).toBe(
      true,
    );
  });
});
