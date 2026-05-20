import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  fetchClients,
  fetchCreativeIterations,
  fetchCreativesByBrief,
  fetchCreativesByIds,
  fetchVideoCreativesByBrief,
  fetchVideoCreativesByIdsWithOutline,
  fetchVideoIterations,
  signStoragePath,
  signStoragePaths,
} from "./client-data";

function okJson(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

function httpError(status: number) {
  return { ok: false, status, json: () => Promise.resolve({}) } as unknown as Response;
}

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchSpy = vi.fn();
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("signStoragePaths", () => {
  it("returns {} for an empty path list without calling fetch", async () => {
    const out = await signStoragePaths("creatives", []);
    expect(out).toEqual({});
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("dedupes paths and posts to /api/storage/sign", async () => {
    fetchSpy.mockResolvedValue(okJson({ urls: { "a.png": "https://x/a", "b.png": null } }));
    const out = await signStoragePaths("creatives", ["a.png", "a.png", "b.png"], 600);
    expect(out).toEqual({ "a.png": "https://x/a", "b.png": null });
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("/api/storage/sign");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      bucket: "creatives",
      paths: ["a.png", "b.png"],
      expiresIn: 600,
    });
  });

  it("guarantees a key per requested path when the server omits some", async () => {
    fetchSpy.mockResolvedValue(okJson({ urls: { "a.png": "https://x/a" } }));
    const out = await signStoragePaths("creatives", ["a.png", "b.png"]);
    expect(out).toEqual({ "a.png": "https://x/a", "b.png": null });
  });

  it("maps every path to null on a non-OK response", async () => {
    fetchSpy.mockResolvedValue(httpError(500));
    const out = await signStoragePaths("creatives", ["a.png", "b.png"]);
    expect(out).toEqual({ "a.png": null, "b.png": null });
  });

  it("maps every path to null when fetch rejects", async () => {
    fetchSpy.mockRejectedValue(new Error("offline"));
    const out = await signStoragePaths("creatives", ["a.png"]);
    expect(out).toEqual({ "a.png": null });
  });

  it("signStoragePath returns the single URL or null", async () => {
    fetchSpy.mockResolvedValue(okJson({ urls: { "a.png": "https://x/a" } }));
    expect(await signStoragePath("creatives", "a.png")).toBe("https://x/a");

    fetchSpy.mockResolvedValue(okJson({ urls: {} }));
    expect(await signStoragePath("creatives", "missing.png")).toBeNull();
  });
});

describe("read helpers", () => {
  it("fetchClients unwraps { clients }", async () => {
    fetchSpy.mockResolvedValue(okJson({ clients: [{ id: "c1" }] }));
    expect(await fetchClients()).toEqual([{ id: "c1" }]);
    expect(fetchSpy).toHaveBeenCalledWith("/api/clients", { cache: "no-store" });
  });

  it("fetchClients returns [] when the key is absent", async () => {
    fetchSpy.mockResolvedValue(okJson({}));
    expect(await fetchClients()).toEqual([]);
  });

  it("read helpers throw on HTTP error", async () => {
    fetchSpy.mockResolvedValue(httpError(403));
    await expect(fetchClients()).rejects.toThrow("HTTP 403");
  });

  it("fetchCreativeIterations hits the per-creative endpoint", async () => {
    fetchSpy.mockResolvedValue(okJson({ iterations: [{ id: "i1" }] }));
    expect(await fetchCreativeIterations("c1")).toEqual([{ id: "i1" }]);
    expect(fetchSpy).toHaveBeenCalledWith("/api/creatives/c1/iterations", { cache: "no-store" });
  });

  it("fetchVideoIterations hits the per-video-creative endpoint", async () => {
    fetchSpy.mockResolvedValue(okJson({ iterations: [] }));
    expect(await fetchVideoIterations("v1")).toEqual([]);
    expect(fetchSpy).toHaveBeenCalledWith("/api/creatives/video/v1/iterations", {
      cache: "no-store",
    });
  });

  it("fetchCreativesByBrief queries by brief_id", async () => {
    fetchSpy.mockResolvedValue(okJson({ creatives: [{ id: "c1" }] }));
    expect(await fetchCreativesByBrief("b1")).toEqual([{ id: "c1" }]);
    expect(fetchSpy).toHaveBeenCalledWith("/api/creatives?brief_id=b1", { cache: "no-store" });
  });

  it("fetchCreativesByIds returns [] for empty ids without fetching", async () => {
    expect(await fetchCreativesByIds([])).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("fetchCreativesByIds joins the id set", async () => {
    fetchSpy.mockResolvedValue(okJson({ creatives: [{ id: "c1" }, { id: "c2" }] }));
    await fetchCreativesByIds(["c1", "c2"]);
    expect(fetchSpy).toHaveBeenCalledWith("/api/creatives?ids=c1%2Cc2", { cache: "no-store" });
  });

  it("fetchVideoCreativesByBrief queries by brief_id", async () => {
    fetchSpy.mockResolvedValue(okJson({ creatives: [] }));
    await fetchVideoCreativesByBrief("b1");
    expect(fetchSpy).toHaveBeenCalledWith("/api/creatives/video?brief_id=b1", {
      cache: "no-store",
    });
  });

  it("fetchVideoCreativesByIdsWithOutline returns empty for no ids", async () => {
    expect(await fetchVideoCreativesByIdsWithOutline([])).toEqual({ creatives: [], outlines: {} });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("fetchVideoCreativesByIdsWithOutline requests outlines + unwraps both keys", async () => {
    fetchSpy.mockResolvedValue(
      okJson({ creatives: [{ id: "v1" }], outlines: { b1: { hook: "h" } } }),
    );
    const out = await fetchVideoCreativesByIdsWithOutline(["v1"]);
    expect(out).toEqual({ creatives: [{ id: "v1" }], outlines: { b1: { hook: "h" } } });
    expect(fetchSpy).toHaveBeenCalledWith("/api/creatives/video?ids=v1&with_outline=1", {
      cache: "no-store",
    });
  });

  it("fetchVideoCreativesByIdsWithOutline defaults missing keys", async () => {
    fetchSpy.mockResolvedValue(okJson({}));
    expect(await fetchVideoCreativesByIdsWithOutline(["v1"])).toEqual({
      creatives: [],
      outlines: {},
    });
  });
});
