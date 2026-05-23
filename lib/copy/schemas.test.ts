import { describe, expect, it } from "vitest";

import { CopyDecisionInput, UpsertCopyInput } from "./schemas";

const uuid = "11111111-1111-4111-8111-111111111111";

describe("UpsertCopyInput", () => {
  it("accepts a minimal create payload and defaults platform to meta", () => {
    const r = UpsertCopyInput.parse({ creative_id: uuid, variant_index: 1 });
    expect(r.platform).toBe("meta");
  });

  it("accepts an edit payload with id", () => {
    expect(
      UpsertCopyInput.safeParse({ id: uuid, creative_id: uuid, variant_index: 2 }).success,
    ).toBe(true);
  });

  it("rejects a missing creative_id", () => {
    expect(UpsertCopyInput.safeParse({ variant_index: 1 }).success).toBe(false);
  });

  it("rejects variant_index out of range", () => {
    expect(UpsertCopyInput.safeParse({ creative_id: uuid, variant_index: 0 }).success).toBe(false);
    expect(UpsertCopyInput.safeParse({ creative_id: uuid, variant_index: 99 }).success).toBe(false);
  });

  it("rejects a bad platform", () => {
    expect(
      UpsertCopyInput.safeParse({ creative_id: uuid, variant_index: 1, platform: "x" }).success,
    ).toBe(false);
  });
});

describe("CopyDecisionInput", () => {
  it("approves without notes", () => {
    expect(CopyDecisionInput.safeParse({ id: uuid, decision: "approved" }).success).toBe(true);
  });

  it("rejects require notes", () => {
    expect(CopyDecisionInput.safeParse({ id: uuid, decision: "rejected" }).success).toBe(false);
    expect(
      CopyDecisionInput.safeParse({ id: uuid, decision: "rejected", notes: "x" }).success,
    ).toBe(true);
  });

  it("rejects whitespace-only notes on reject", () => {
    expect(
      CopyDecisionInput.safeParse({ id: uuid, decision: "rejected", notes: "   " }).success,
    ).toBe(false);
  });

  it("rejects a bad id", () => {
    expect(CopyDecisionInput.safeParse({ id: "no", decision: "approved" }).success).toBe(false);
  });
});
