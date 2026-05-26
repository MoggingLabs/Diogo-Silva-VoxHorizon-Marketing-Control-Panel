import { describe, expect, it } from "vitest";

import { imageBriefToRow, mergeBriefRows, videoBriefToRow } from "./briefs-unified";

const baseImage = {
  id: "i1",
  brief_id_human: "img-1",
  client_id: "c1",
  status: "draft" as const,
  payload: { service: "roofing", budget: 5000, market: "Austin" },
  created_at: "2026-05-20T00:00:00Z",
  deleted_at: null,
};

const baseVideo = {
  id: "v1",
  brief_id_human: "vid-1",
  client_id: "c2",
  status: "posted" as const,
  created_at: "2026-05-21T00:00:00Z",
  dimensions: "9x16" as const,
  target_duration_s: 30,
  deleted_at: null,
};

describe("imageBriefToRow", () => {
  it("maps the row + joins the client name + builds service/market", () => {
    const row = imageBriefToRow(baseImage, { c1: "Acme Co" });
    expect(row).toMatchObject({
      id: "i1",
      format: "image",
      briefIdHuman: "img-1",
      clientName: "Acme Co",
      serviceMarket: "roofing · Austin",
      href: "/briefs/i1",
      deletedAt: null,
    });
  });

  it("falls back to null client name when not in the map", () => {
    const row = imageBriefToRow(baseImage, {});
    expect(row.clientName).toBeNull();
  });

  it("handles a malformed payload without throwing (empty service/market)", () => {
    const row = imageBriefToRow({ ...baseImage, payload: null as never }, {});
    expect(row.serviceMarket).toBe("");
  });

  it("surfaces the deleted_at tombstone", () => {
    const row = imageBriefToRow({ ...baseImage, deleted_at: "2026-05-25T00:00:00Z" }, {});
    expect(row.deletedAt).toBe("2026-05-25T00:00:00Z");
  });
});

describe("videoBriefToRow", () => {
  it("maps the row + uses the video detail href + dimensions/duration", () => {
    const row = videoBriefToRow(baseVideo, { c2: "Beta LLC" });
    expect(row).toMatchObject({
      id: "v1",
      format: "video",
      briefIdHuman: "vid-1",
      clientName: "Beta LLC",
      serviceMarket: "9x16 · 30s",
      href: "/briefs/video/v1",
    });
  });

  it("tolerates missing dimensions + duration", () => {
    const row = videoBriefToRow({ ...baseVideo, dimensions: null, target_duration_s: null }, {});
    expect(row.serviceMarket).toBe("");
  });
});

describe("mergeBriefRows", () => {
  it("merges and sorts by createdAt descending", () => {
    const image = [imageBriefToRow(baseImage, {})]; // 05-20
    const video = [videoBriefToRow(baseVideo, {})]; // 05-21
    const merged = mergeBriefRows(image, video);
    expect(merged.map((r) => r.id)).toEqual(["v1", "i1"]);
  });

  it("returns an empty list when both are empty", () => {
    expect(mergeBriefRows([], [])).toEqual([]);
  });
});
