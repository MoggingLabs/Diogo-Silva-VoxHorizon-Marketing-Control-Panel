import { afterEach, describe, expect, it, vi } from "vitest";

import { jsonResponse, spyOnFetch, textResponse } from "@/tests/unit/helpers/worker-mock";
import { archiveLaunch, listLaunches, restoreLaunch, updateLaunch } from "./client";

afterEach(() => vi.restoreAllMocks());

describe("lib/launches/client", () => {
  describe("listLaunches", () => {
    it("GETs the image endpoint and returns the launches", async () => {
      const spy = spyOnFetch();
      spy.mockResolvedValueOnce(jsonResponse({ launches: [{ id: "l1" }] }));
      const rows = await listLaunches("image");
      expect(rows).toHaveLength(1);
      expect(String(spy.mock.calls[0]![0])).toBe("/api/launches");
    });

    it("routes to the video endpoint and adds ?archived=true", async () => {
      const spy = spyOnFetch();
      spy.mockResolvedValueOnce(jsonResponse({ launches: [] }));
      await listLaunches("video", { archived: true });
      expect(String(spy.mock.calls[0]![0])).toBe("/api/launches/video?archived=true");
    });

    it("returns [] when the payload omits launches", async () => {
      const spy = spyOnFetch();
      spy.mockResolvedValueOnce(jsonResponse({}));
      expect(await listLaunches("image")).toEqual([]);
    });

    it("throws the parsed JSON error on a non-2xx", async () => {
      const spy = spyOnFetch();
      spy.mockResolvedValueOnce(jsonResponse({ error: "boom" }, { status: 500 }));
      await expect(listLaunches("image")).rejects.toThrow(/boom/);
    });

    it("throws the raw text when the error body is not JSON", async () => {
      const spy = spyOnFetch();
      spy.mockResolvedValueOnce(textResponse("plain failure", { status: 502 }));
      await expect(listLaunches("image")).rejects.toThrow(/plain failure/);
    });
  });

  describe("archiveLaunch", () => {
    it("DELETEs the image endpoint", async () => {
      const spy = spyOnFetch();
      spy.mockResolvedValueOnce(jsonResponse({ launch: { id: "l1" } }));
      await archiveLaunch("image", "l1");
      expect(String(spy.mock.calls[0]![0])).toBe("/api/launches/l1");
      expect((spy.mock.calls[0]![1] as RequestInit).method).toBe("DELETE");
    });

    it("throws on a 409 conflict", async () => {
      const spy = spyOnFetch();
      spy.mockResolvedValueOnce(jsonResponse({ error: "already_archived" }, { status: 409 }));
      await expect(archiveLaunch("video", "v1")).rejects.toThrow(/already_archived/);
    });
  });

  describe("restoreLaunch", () => {
    it("POSTs the restore endpoint (video)", async () => {
      const spy = spyOnFetch();
      spy.mockResolvedValueOnce(jsonResponse({ launch: { id: "v1" } }));
      await restoreLaunch("video", "v1");
      expect(String(spy.mock.calls[0]![0])).toBe("/api/launches/video/v1/restore");
      expect((spy.mock.calls[0]![1] as RequestInit).method).toBe("POST");
    });
  });

  describe("updateLaunch", () => {
    it("PATCHes the endpoint with the notes body", async () => {
      const spy = spyOnFetch();
      spy.mockResolvedValueOnce(jsonResponse({ launch: { id: "l1" } }));
      await updateLaunch("image", "l1", { decided_notes: "hi" });
      const [url, init] = spy.mock.calls[0]!;
      expect(String(url)).toBe("/api/launches/l1");
      expect((init as RequestInit).method).toBe("PATCH");
      expect((init as RequestInit).body).toBe(JSON.stringify({ decided_notes: "hi" }));
    });
  });
});
