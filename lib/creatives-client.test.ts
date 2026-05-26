import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  archiveCreative,
  listImageCreatives,
  listVideoCreatives,
  overrideCompliance,
  overrideSpec,
  rerunQa,
  restoreCreative,
  updateImageCreative,
  updateVideoCreative,
} from "./creatives-client";

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

describe("listImageCreatives / listVideoCreatives", () => {
  it("lists active image creatives", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ creatives: [{ id: "c1" }] }));
    const rows = await listImageCreatives();
    expect(rows).toEqual([{ id: "c1" }]);
    expect(fetchMock).toHaveBeenCalledWith("/api/creatives", { cache: "no-store" });
  });

  it("lists archived video creatives via the query param", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ creatives: [{ id: "v1" }] }));
    const rows = await listVideoCreatives({ archived: true });
    expect(rows).toEqual([{ id: "v1" }]);
    expect(fetchMock).toHaveBeenCalledWith("/api/creatives/video?archived=true", {
      cache: "no-store",
    });
  });

  it("lists active video creatives (no archived param)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ creatives: [{ id: "v2" }] }));
    const rows = await listVideoCreatives();
    expect(rows).toEqual([{ id: "v2" }]);
    expect(fetchMock).toHaveBeenCalledWith("/api/creatives/video", { cache: "no-store" });
  });

  it("lists archived image creatives via the query param", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ creatives: [{ id: "c9" }] }));
    const rows = await listImageCreatives({ archived: true });
    expect(rows).toEqual([{ id: "c9" }]);
    expect(fetchMock).toHaveBeenCalledWith("/api/creatives?archived=true", { cache: "no-store" });
  });

  it("throws with the server error message on a non-2xx", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "rls denied" }, { status: 500 }));
    await expect(listImageCreatives()).rejects.toThrow(/rls denied/);
  });
});

describe("updateImageCreative / updateVideoCreative", () => {
  it("PATCHes image metadata and returns the row", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ creative: { id: "c1", concept: "x" } }));
    const out = await updateImageCreative("c1", { concept: "x" });
    expect(out).toEqual({ id: "c1", concept: "x" });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/creatives/c1");
    expect(init).toMatchObject({ method: "PATCH" });
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ concept: "x" });
  });

  it("PATCHes video metadata", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ creative: { id: "v1", asset_name: "y" } }));
    const out = await updateVideoCreative("v1", { asset_name: "y" });
    expect(out).toEqual({ id: "v1", asset_name: "y" });
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/creatives/video/v1");
  });

  it("throws on a 404 update", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "not_found" }, { status: 404 }));
    await expect(updateImageCreative("c1", { concept: "x" })).rejects.toThrow(/not_found/);
  });

  it("throws on a video update error", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "nothing to update" }, { status: 400 }));
    await expect(updateVideoCreative("v1", { asset_name: "y" })).rejects.toThrow(
      /nothing to update/,
    );
  });
});

describe("archiveCreative / restoreCreative", () => {
  it("DELETEs an image creative", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ creative: { id: "c1" } }));
    await archiveCreative("image", "c1");
    expect(fetchMock).toHaveBeenCalledWith("/api/creatives/c1", {
      method: "DELETE",
      cache: "no-store",
    });
  });

  it("POSTs restore for a video creative", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ creative: { id: "v1" } }));
    await restoreCreative("video", "v1");
    expect(fetchMock).toHaveBeenCalledWith("/api/creatives/video/v1/restore", {
      method: "POST",
      cache: "no-store",
    });
  });

  it("throws with the inlined error on archive conflict", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "already_archived" }, { status: 409 }));
    await expect(archiveCreative("image", "c1")).rejects.toThrow(/already_archived/);
  });

  it("falls back to the raw body when it is not JSON", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("upstream boom", { status: 502, headers: { "content-type": "text/plain" } }),
    );
    await expect(restoreCreative("image", "c1")).rejects.toThrow(/upstream boom/);
  });

  it("falls back to statusText when the error body is empty", async () => {
    fetchMock.mockResolvedValueOnce(new Response("", { status: 503, statusText: "Service Down" }));
    await expect(archiveCreative("image", "c1")).rejects.toThrow(/Service Down/);
  });
});

describe("rerunQa (append-only QA re-run)", () => {
  it("POSTs to the QA route with the surface and returns the result", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ ok: true, rollup: "passed", results: [], errors: [] }),
    );
    const out = await rerunQa("c1", { surface: "image" });
    expect(out.rollup).toBe("passed");
    expect(fetchMock).toHaveBeenCalledWith("/api/creatives/c1/qa", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ surface: "image" }),
      cache: "no-store",
    });
  });

  it("defaults to an empty body when no opts are given", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ ok: true, rollup: "pending", results: [], errors: [] }),
    );
    await rerunQa("c1");
    expect((fetchMock.mock.calls[0]![1] as RequestInit).body).toBe("{}");
  });

  it("throws the inlined error on a non-2xx", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "worker_unreachable" }, { status: 502 }));
    await expect(rerunQa("c1")).rejects.toThrow(/worker_unreachable/);
  });
});

describe("overrideSpec (override-route only)", () => {
  it("POSTs the corrected placement result to the spec route", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));
    await overrideSpec("c1", { placement: "feed", status: "pass", reason: "ok" });
    expect(fetchMock).toHaveBeenCalledWith("/api/creatives/c1/spec", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ placement: "feed", status: "pass", reason: "ok" }),
      cache: "no-store",
    });
  });

  it("throws the inlined error on a non-2xx", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "validation_failed" }, { status: 422 }));
    await expect(
      overrideSpec("c1", { placement: "feed", status: "pass", reason: "" }),
    ).rejects.toThrow(/validation_failed/);
  });
});

describe("overrideCompliance (existing pipeline route)", () => {
  it("POSTs to the pipeline compliance-override route", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));
    await overrideCompliance("pp1", { creative_id: "c1", override_note: "reviewed" });
    expect(fetchMock).toHaveBeenCalledWith("/api/pipelines/pp1/compliance/override", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ creative_id: "c1", override_note: "reviewed" }),
      cache: "no-store",
    });
  });

  it("throws the inlined error on a non-2xx", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "not found" }, { status: 404 }));
    await expect(
      overrideCompliance("pp1", { creative_id: "c1", override_note: "x" }),
    ).rejects.toThrow(/not found/);
  });
});
