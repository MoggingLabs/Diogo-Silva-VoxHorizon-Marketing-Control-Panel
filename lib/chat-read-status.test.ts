/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { countUnread, firstUnreadIndex, getLastSeen, markRead } from "./chat-read-status";

const STORAGE_KEY = "voxhorizon.chat.lastSeen.v1";

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("getLastSeen", () => {
  it("returns null for an empty creativeId", async () => {
    expect(await getLastSeen("")).toBeNull();
  });

  it("returns null when nothing is persisted", async () => {
    expect(await getLastSeen("c1")).toBeNull();
  });

  it("returns the persisted timestamp", async () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ c1: "2026-05-17T10:00:00Z" }));
    expect(await getLastSeen("c1")).toBe("2026-05-17T10:00:00Z");
  });

  it("ignores a corrupt blob and returns null", async () => {
    window.localStorage.setItem(STORAGE_KEY, "not-json");
    expect(await getLastSeen("c1")).toBeNull();
  });

  it("ignores a non-object blob", async () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([1, 2, 3]));
    expect(await getLastSeen("c1")).toBeNull();
  });
});

describe("markRead", () => {
  it("no-ops for an empty id", async () => {
    await markRead("");
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("stamps the supplied timestamp and fires a POST", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    await markRead("c1", "2026-05-17T10:00:00Z");
    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}");
    expect(stored.c1).toBe("2026-05-17T10:00:00Z");
    // Best-effort fetch was attempted.
    expect(fetchSpy).toHaveBeenCalledWith("/api/chat-read-status", expect.any(Object));
  });

  it("defaults to now when no isoTimestamp is supplied", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    const before = Date.now();
    await markRead("c2");
    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}");
    expect(typeof stored.c2).toBe("string");
    const at = new Date(stored.c2).getTime();
    expect(at).toBeGreaterThanOrEqual(before);
  });

  it("survives a localStorage write that throws", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    await expect(markRead("c1", "2026-05-17T10:00:00Z")).resolves.toBeUndefined();
  });

  it("silently swallows fetch failures", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    await expect(markRead("c1", "2026-05-17T10:00:00Z")).resolves.toBeUndefined();
  });
});

describe("countUnread / firstUnreadIndex", () => {
  const msgs = [
    { id: "a", createdAt: "2026-05-17T10:00:00Z" },
    { id: "b", createdAt: "2026-05-17T11:00:00Z" },
    { id: "c", createdAt: "2026-05-17T12:00:00Z" },
  ];

  it("returns 0 / -1 when lastSeen is null (first visit)", () => {
    expect(countUnread(null, msgs)).toBe(0);
    expect(firstUnreadIndex(null, msgs)).toBe(-1);
  });

  it("counts strictly later messages", () => {
    expect(countUnread("2026-05-17T10:30:00Z", msgs)).toBe(2);
    expect(firstUnreadIndex("2026-05-17T10:30:00Z", msgs)).toBe(1);
  });

  it("returns 0 / -1 when nothing is newer than lastSeen", () => {
    expect(countUnread("2026-05-17T12:00:00Z", msgs)).toBe(0);
    expect(firstUnreadIndex("2026-05-17T12:00:00Z", msgs)).toBe(-1);
  });

  it("returns 0 / -1 when lastSeen is unparseable", () => {
    expect(countUnread("not a date", msgs)).toBe(0);
    expect(firstUnreadIndex("not a date", msgs)).toBe(-1);
  });

  it("skips messages with non-finite timestamps", () => {
    const m = [
      { id: "a", createdAt: "2026-05-17T10:00:00Z" },
      { id: "b", createdAt: "garbage" },
      { id: "c", createdAt: "2026-05-17T12:00:00Z" },
    ];
    expect(countUnread("2026-05-17T09:00:00Z", m)).toBe(2);
    expect(firstUnreadIndex("2026-05-17T09:00:00Z", m)).toBe(0);
  });
});
