import { describe, expect, it, vi } from "vitest";

import {
  ApprovalModeInput,
  MAX_TTL_SECONDS,
  MIN_TTL_SECONDS,
  TTL_PRESETS,
  formatTtlShort,
  ttlRemainingMs,
} from "./types";

describe("ApprovalModeInput schema", () => {
  it("accepts ASK without ttl_seconds", () => {
    expect(ApprovalModeInput.safeParse({ mode: "ASK" }).success).toBe(true);
  });

  it("accepts HALT without ttl_seconds", () => {
    expect(ApprovalModeInput.safeParse({ mode: "HALT" }).success).toBe(true);
  });

  it("accepts AUTO_APPROVE with a valid ttl", () => {
    const r = ApprovalModeInput.safeParse({
      mode: "AUTO_APPROVE",
      ttl_seconds: 3600,
    });
    expect(r.success).toBe(true);
  });

  it("rejects unknown mode", () => {
    expect(ApprovalModeInput.safeParse({ mode: "REJECT_ALL" }).success).toBe(false);
  });

  it("rejects AUTO_APPROVE without ttl_seconds", () => {
    expect(ApprovalModeInput.safeParse({ mode: "AUTO_APPROVE" }).success).toBe(false);
  });

  it("rejects ASK with ttl_seconds", () => {
    expect(ApprovalModeInput.safeParse({ mode: "ASK", ttl_seconds: 3600 }).success).toBe(false);
  });

  it("rejects HALT with ttl_seconds", () => {
    expect(ApprovalModeInput.safeParse({ mode: "HALT", ttl_seconds: 3600 }).success).toBe(false);
  });

  it("rejects ttl_seconds below the minimum", () => {
    expect(
      ApprovalModeInput.safeParse({
        mode: "AUTO_APPROVE",
        ttl_seconds: MIN_TTL_SECONDS - 1,
      }).success,
    ).toBe(false);
  });

  it("rejects ttl_seconds above the maximum", () => {
    expect(
      ApprovalModeInput.safeParse({
        mode: "AUTO_APPROVE",
        ttl_seconds: MAX_TTL_SECONDS + 1,
      }).success,
    ).toBe(false);
  });

  it("accepts ttl_seconds at the minimum", () => {
    expect(
      ApprovalModeInput.safeParse({
        mode: "AUTO_APPROVE",
        ttl_seconds: MIN_TTL_SECONDS,
      }).success,
    ).toBe(true);
  });

  it("accepts ttl_seconds at the maximum", () => {
    expect(
      ApprovalModeInput.safeParse({
        mode: "AUTO_APPROVE",
        ttl_seconds: MAX_TTL_SECONDS,
      }).success,
    ).toBe(true);
  });

  it("rejects non-integer ttl_seconds", () => {
    expect(
      ApprovalModeInput.safeParse({
        mode: "AUTO_APPROVE",
        ttl_seconds: 3600.5,
      }).success,
    ).toBe(false);
  });

  it("trims a 2000-character note OK but rejects 2001", () => {
    expect(
      ApprovalModeInput.safeParse({
        mode: "ASK",
        note: "a".repeat(2000),
      }).success,
    ).toBe(true);
    expect(
      ApprovalModeInput.safeParse({
        mode: "ASK",
        note: "a".repeat(2001),
      }).success,
    ).toBe(false);
  });
});

describe("TTL_PRESETS", () => {
  it("has four presets in ascending order", () => {
    expect(TTL_PRESETS.map((p) => p.seconds)).toEqual([3600, 4 * 3600, 12 * 3600, 24 * 3600]);
  });
});

describe("ttlRemainingMs", () => {
  it("returns 0 for null", () => {
    expect(ttlRemainingMs(null)).toBe(0);
  });

  it("returns 0 for a malformed timestamp", () => {
    expect(ttlRemainingMs("not-a-date")).toBe(0);
  });

  it("returns 0 for a past timestamp", () => {
    expect(ttlRemainingMs("2020-01-01T00:00:00Z")).toBe(0);
  });

  it("returns a positive number for a future timestamp", () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    expect(ttlRemainingMs(future)).toBeGreaterThan(0);
  });
});

describe("formatTtlShort", () => {
  it("returns 'expired' for null", () => {
    expect(formatTtlShort(null)).toBe("expired");
  });

  it("returns 'expired' for past timestamps", () => {
    expect(formatTtlShort("2020-01-01T00:00:00Z")).toBe("expired");
  });

  it("returns minutes for <1h remaining", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-19T00:00:00Z"));
    const result = formatTtlShort("2026-05-19T00:30:00Z");
    expect(result).toBe("30m");
    vi.useRealTimers();
  });

  it("returns HHmMMm for >1h remaining", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-19T00:00:00Z"));
    const result = formatTtlShort("2026-05-19T03:12:00Z");
    expect(result).toBe("03h12m");
    vi.useRealTimers();
  });

  it("pads single-digit hours/minutes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-19T00:00:00Z"));
    const result = formatTtlShort("2026-05-19T01:05:00Z");
    expect(result).toBe("01h05m");
    vi.useRealTimers();
  });
});
