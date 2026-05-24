import { describe, expect, it } from "vitest";

import {
  CLEARED_STAGE_STATES,
  MIN_APPROVED_COPY,
  copyGateCleared,
  isCreativeInScope,
  isStageStateCleared,
  rollupCleared,
} from "./rollup";

describe("CLEARED_STAGE_STATES / isStageStateCleared", () => {
  it("treats passed/overridden/skipped as cleared", () => {
    expect([...CLEARED_STAGE_STATES].sort()).toEqual(["overridden", "passed", "skipped"]);
    for (const s of ["passed", "overridden", "skipped"] as const) {
      expect(isStageStateCleared(s)).toBe(true);
    }
  });
  it("treats pending/in_progress/failed as not cleared", () => {
    for (const s of ["pending", "in_progress", "failed"] as const) {
      expect(isStageStateCleared(s)).toBe(false);
    }
  });
});

describe("isCreativeInScope", () => {
  it("includes a plain draft creative", () => {
    expect(isCreativeInScope({ status: "draft" })).toBe(true);
  });
  it("drops a killed creative", () => {
    expect(isCreativeInScope({ status: "killed" })).toBe(false);
  });
  it("drops a soft-deleted creative regardless of status", () => {
    expect(isCreativeInScope({ status: "approved", deleted_at: "2026-01-01T00:00:00Z" })).toBe(
      false,
    );
  });
  it("includes a video creative (no killed status) when not deleted", () => {
    expect(isCreativeInScope({ status: "composed" })).toBe(true);
  });
});

describe("rollupCleared (core)", () => {
  it("is not cleared with zero verdicts", () => {
    expect(rollupCleared([])).toEqual({ cleared: false, total: 0, blocking: 0 });
  });
  it("is cleared when every verdict is terminal-good", () => {
    expect(rollupCleared(["passed", "overridden", "skipped"])).toEqual({
      cleared: true,
      total: 3,
      blocking: 0,
    });
  });
  it("is blocked when any verdict is not cleared", () => {
    expect(rollupCleared(["passed", "failed", "pending"])).toEqual({
      cleared: false,
      total: 3,
      blocking: 2,
    });
  });
});

describe("copyGateCleared", () => {
  const counts = (m: Record<string, number>) => new Map(Object.entries(m));

  it(`is cleared when every in-scope creative has >=${MIN_APPROVED_COPY} approved`, () => {
    expect(copyGateCleared(["a", "b"], counts({ a: 3, b: 4 }))).toEqual({
      cleared: true,
      total: 2,
      short: 1 - 1, // 0
    });
  });
  it("counts creatives short on approved copy", () => {
    expect(copyGateCleared(["a", "b"], counts({ a: 3, b: 1 }))).toEqual({
      cleared: false,
      total: 2,
      short: 1,
    });
  });
  it("treats a creative with no approved copy as short", () => {
    expect(copyGateCleared(["a"], counts({}))).toEqual({ cleared: false, total: 1, short: 1 });
  });
  it("is not cleared with zero in-scope creatives", () => {
    expect(copyGateCleared([], counts({}))).toEqual({ cleared: false, total: 0, short: 0 });
  });
});
