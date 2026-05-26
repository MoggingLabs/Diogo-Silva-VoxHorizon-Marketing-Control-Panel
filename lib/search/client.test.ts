/**
 * Unit tests for the global-search fetch wrapper + grouping (Makeover M7).
 *
 * Covers: blank-query short circuit (no fetch), URL encoding, a successful
 * response, a missing `results` field, a non-2xx throw, abort propagation, and
 * the grouping helper (order preservation + merging image/video kinds).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  groupSearchResults,
  searchResources,
  SEARCH_KIND_LABEL,
  type SearchResult,
} from "./client";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function mockFetch(body: unknown, ok = true, status = 200) {
  const fn = vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
  );
  // The real Response above already carries `ok` from status; for the non-ok
  // case the caller passes status >= 400 so ok is false.
  void ok;
  vi.stubGlobal("fetch", fn);
  return fn;
}

describe("searchResources", () => {
  it("returns [] for a blank query without calling fetch", async () => {
    const fn = vi.fn();
    vi.stubGlobal("fetch", fn);
    expect(await searchResources("   ")).toEqual([]);
    expect(fn).not.toHaveBeenCalled();
  });

  it("fetches with an encoded query and returns the results", async () => {
    const results: SearchResult[] = [
      { kind: "client", id: "c1", label: "Acme", href: "/clients/c1" },
    ];
    const fn = mockFetch({ results });
    const out = await searchResources("a&b client");
    expect(out).toEqual(results);
    expect(fn).toHaveBeenCalledWith(
      "/api/search?q=a%26b%20client",
      expect.objectContaining({ headers: { Accept: "application/json" } }),
    );
  });

  it("defaults to [] when the body has no results field", async () => {
    mockFetch({});
    expect(await searchResources("x")).toEqual([]);
  });

  it("throws on a non-2xx response", async () => {
    mockFetch({ error: "boom" }, false, 500);
    await expect(searchResources("x")).rejects.toThrow(/Search failed \(500\)/);
  });

  it("forwards the abort signal and propagates AbortError", async () => {
    const controller = new AbortController();
    const fn = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.signal?.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fn);
    controller.abort();
    await expect(searchResources("x", controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(fn).toHaveBeenCalled();
  });
});

describe("groupSearchResults", () => {
  it("returns no groups for an empty list", () => {
    expect(groupSearchResults([])).toEqual([]);
  });

  it("merges image/video kinds under one heading and preserves arrival order", () => {
    const results: SearchResult[] = [
      { kind: "brief", id: "b1", label: "B1", href: "/briefs/b1" },
      { kind: "client", id: "c1", label: "C1", href: "/clients/c1" },
      { kind: "video_brief", id: "vb1", label: "VB1", href: "/briefs/vb1?format=video" },
      { kind: "creative", id: "cr1", label: "CR1", href: "/creatives/b1" },
    ];
    const groups = groupSearchResults(results);
    // "Briefs" appears first (from the first brief) and absorbs the video brief.
    expect(groups.map((g) => g.heading)).toEqual(["Briefs", "Clients", "Creatives"]);
    const briefs = groups.find((g) => g.heading === "Briefs")!;
    expect(briefs.items.map((i) => i.id)).toEqual(["b1", "vb1"]);
  });

  it("exposes a label for every kind", () => {
    for (const label of Object.values(SEARCH_KIND_LABEL)) {
      expect(typeof label).toBe("string");
      expect(label.length).toBeGreaterThan(0);
    }
  });
});
