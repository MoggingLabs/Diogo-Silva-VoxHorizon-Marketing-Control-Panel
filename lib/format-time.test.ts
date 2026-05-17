import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { formatDate, formatDuration, timeSince } from "./format-time";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-05-17T12:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("timeSince", () => {
  it("returns dash for nullish input", () => {
    expect(timeSince(null)).toBe("—");
    expect(timeSince(undefined)).toBe("—");
  });

  it("handles bad strings + invalid Dates", () => {
    expect(timeSince("not-a-date")).toBe("—");
    expect(timeSince(new Date("bad"))).toBe("—");
  });

  it("returns 'just now' for under a minute", () => {
    expect(timeSince(new Date("2026-05-17T11:59:30Z"))).toBe("just now");
  });

  it("returns 'just now' for future timestamps", () => {
    expect(timeSince(new Date("2026-05-17T13:00:00Z"))).toBe("just now");
  });

  it("returns minutes for under an hour", () => {
    expect(timeSince(new Date("2026-05-17T11:45:00Z"))).toBe("15m ago");
  });

  it("returns hours for under a day", () => {
    expect(timeSince(new Date("2026-05-17T09:00:00Z"))).toBe("3h ago");
  });

  it("returns days for under 30 days", () => {
    expect(timeSince(new Date("2026-05-15T12:00:00Z"))).toBe("2d ago");
  });

  it("returns months for older", () => {
    expect(timeSince(new Date("2026-03-01T12:00:00Z"))).toMatch(/mo ago/);
  });

  it("accepts an ISO string", () => {
    expect(timeSince("2026-05-17T11:45:00Z")).toBe("15m ago");
  });
});

describe("formatDuration", () => {
  it("returns dash for non-finite / null", () => {
    expect(formatDuration(null)).toBe("—");
    expect(formatDuration(undefined)).toBe("—");
    expect(formatDuration(NaN)).toBe("—");
    expect(formatDuration(Infinity)).toBe("—");
  });

  it("zero-pads minutes + seconds", () => {
    expect(formatDuration(0)).toBe("00:00");
    expect(formatDuration(5)).toBe("00:05");
    expect(formatDuration(125)).toBe("02:05");
  });

  it("clamps negative inputs to zero", () => {
    expect(formatDuration(-3)).toBe("00:00");
  });
});

describe("formatDate", () => {
  it("returns null for nullish", () => {
    expect(formatDate(null)).toBeNull();
    expect(formatDate(undefined)).toBeNull();
  });

  it("returns a formatted string for valid ISO", () => {
    const out = formatDate("2026-05-17T12:00:00Z");
    expect(out).toBeTruthy();
    expect(typeof out).toBe("string");
  });

  it("returns the input on a throw inside Date", () => {
    // Force toLocaleString to throw via a tampered Date prototype.
    const spy = vi.spyOn(Date.prototype, "toLocaleString").mockImplementation(() => {
      throw new Error("boom");
    });
    expect(formatDate("2026-05-17T12:00:00Z")).toBe("2026-05-17T12:00:00Z");
    spy.mockRestore();
  });
});
