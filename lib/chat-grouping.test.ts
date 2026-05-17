import { describe, expect, it, vi } from "vitest";

import { formatDateSeparator, groupMessages } from "./chat-grouping";

describe("formatDateSeparator", () => {
  it("returns 'Today' for the same calendar day as now", () => {
    const now = new Date("2026-05-17T18:00:00Z");
    expect(formatDateSeparator(new Date("2026-05-17T08:00:00Z"), now)).toBe("Today");
  });

  it("returns 'Yesterday' for the prior calendar day", () => {
    const now = new Date("2026-05-17T18:00:00Z");
    expect(formatDateSeparator(new Date("2026-05-16T12:00:00Z"), now)).toBe("Yesterday");
  });

  it("returns a locale-formatted date for older calendar days", () => {
    const now = new Date("2026-05-17T18:00:00Z");
    const out = formatDateSeparator(new Date("2026-01-01T12:00:00Z"), now);
    expect(out).not.toBe("Today");
    expect(out).not.toBe("Yesterday");
    expect(out.length).toBeGreaterThan(0);
  });

  it("falls back to ISO slice when toLocaleDateString throws", () => {
    const date = new Date("2026-05-17T18:00:00Z");
    const spy = vi.spyOn(date, "toLocaleDateString").mockImplementation(() => {
      throw new Error("boom");
    });
    const out = formatDateSeparator(date, new Date("2027-05-17T18:00:00Z"));
    expect(out).toBe(date.toISOString().slice(0, 10));
    spy.mockRestore();
  });
});

describe("groupMessages", () => {
  it("returns an empty array for empty input", () => {
    expect(groupMessages([])).toEqual([]);
  });

  it("emits a date separator before the first message", () => {
    const messages = [{ id: "m1", senderKey: "user", createdAt: "2026-05-17T10:00:00Z" }];
    const items = groupMessages(messages);
    expect(items[0]?.type).toBe("date-separator");
    expect(items[1]).toMatchObject({
      type: "message",
      message: messages[0],
      isFirstInGroup: true,
      isLastInGroup: true,
    });
  });

  it("groups two close messages from the same sender", () => {
    const messages = [
      { id: "a", senderKey: "u", createdAt: "2026-05-17T10:00:00Z" },
      { id: "b", senderKey: "u", createdAt: "2026-05-17T10:01:00Z" },
    ];
    const items = groupMessages(messages);
    const msgs = items.filter((i) => i.type === "message");
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toMatchObject({ isFirstInGroup: true, isLastInGroup: false });
    expect(msgs[1]).toMatchObject({ isFirstInGroup: false, isLastInGroup: true });
  });

  it("splits groups when the sender changes", () => {
    const messages = [
      { id: "a", senderKey: "u", createdAt: "2026-05-17T10:00:00Z" },
      { id: "b", senderKey: "a", createdAt: "2026-05-17T10:01:00Z" },
    ];
    const items = groupMessages(messages);
    const msgs = items.filter((i) => i.type === "message");
    expect(msgs[0]).toMatchObject({ isFirstInGroup: true, isLastInGroup: true });
    expect(msgs[1]).toMatchObject({ isFirstInGroup: true, isLastInGroup: true });
  });

  it("splits groups when 5 minutes elapse", () => {
    const messages = [
      { id: "a", senderKey: "u", createdAt: "2026-05-17T10:00:00Z" },
      { id: "b", senderKey: "u", createdAt: "2026-05-17T10:10:00Z" },
    ];
    const items = groupMessages(messages);
    const msgs = items.filter((i) => i.type === "message");
    expect(msgs[0]).toMatchObject({ isFirstInGroup: true, isLastInGroup: true });
    expect(msgs[1]).toMatchObject({ isFirstInGroup: true, isLastInGroup: true });
  });

  it("inserts separators across date boundaries", () => {
    // Use noon-UTC stamps several days apart so the boundary is unambiguous
    // regardless of the local timezone (`isSameDay` uses local date parts).
    const messages = [
      { id: "a", senderKey: "u", createdAt: "2026-05-15T12:00:00Z" },
      { id: "b", senderKey: "u", createdAt: "2026-05-17T12:00:00Z" },
    ];
    const items = groupMessages(messages);
    const sepCount = items.filter((i) => i.type === "date-separator").length;
    expect(sepCount).toBe(2);
  });
});
