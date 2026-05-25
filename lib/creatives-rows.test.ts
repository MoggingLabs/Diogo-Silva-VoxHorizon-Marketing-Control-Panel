import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { mockClient } from "@/tests/unit/helpers/api-mock";

import { buildCreativeRows } from "./creatives-rows";

describe("buildCreativeRows", () => {
  it("flattens image + video creatives into unified rows, newest-first", async () => {
    const admin = mockClient({
      creatives: {
        select: {
          data: [
            {
              id: "c1",
              brief_id: "b1",
              concept: "Roof hook",
              ratio: "1x1",
              status: "draft",
              version: "v1",
              created_at: "2026-01-02T00:00:00Z",
              file_path_supabase: "p1.png",
            },
          ],
          error: null,
        },
      },
      video_creatives: {
        select: {
          data: [
            {
              id: "v1",
              brief_id: "vb1",
              status: "captioned",
              version: 2,
              created_at: "2026-01-03T00:00:00Z",
              asset_name: "Hero cut",
            },
          ],
          error: null,
        },
      },
      briefs: { select: { data: [{ id: "b1", brief_id_human: "br-1" }], error: null } },
      video_briefs: { select: { data: [{ id: "vb1", brief_id_human: "vbr-1" }], error: null } },
    });

    const { rows, error } = await buildCreativeRows(admin as never);
    expect(error).toBeNull();
    expect(rows).toHaveLength(2);
    // Newest (video, Jan 3) first.
    expect(rows[0]).toMatchObject({
      id: "v1",
      kind: "video",
      brief_label: "vbr-1",
      concept: "Hero cut",
      version: "v2",
      href: "/creatives/manage/video/v1",
      thumbnail_url: null,
    });
    expect(rows[1]).toMatchObject({
      id: "c1",
      kind: "image",
      brief_label: "br-1",
      format_label: "1x1",
      href: "/creatives/manage/c1",
    });
    // Image thumbnail signed by the mock signer.
    expect(rows[1]?.thumbnail_url).toContain("p1.png");
  });

  it("falls back to the uuid head when a brief label is missing", async () => {
    const admin = mockClient({
      creatives: {
        select: {
          data: [
            {
              id: "c1",
              brief_id: "abcdef12-0000-0000-0000-000000000000",
              concept: null,
              ratio: null,
              status: "draft",
              version: "v1",
              created_at: "2026-01-02T00:00:00Z",
              file_path_supabase: null,
            },
          ],
          error: null,
        },
      },
      video_creatives: { select: { data: [], error: null } },
      briefs: { select: { data: [], error: null } },
    });

    const { rows } = await buildCreativeRows(admin as never);
    expect(rows[0]?.brief_label).toBe("abcdef12");
    expect(rows[0]?.thumbnail_url).toBeNull();
  });

  it("falls back to the uuid head for a video brief that is missing", async () => {
    const admin = mockClient({
      creatives: { select: { data: [], error: null } },
      video_creatives: {
        select: {
          data: [
            {
              id: "v1",
              brief_id: "fedcba98-1111-2222-3333-444455556666",
              status: "captioned",
              version: 1,
              created_at: "2026-01-02T00:00:00Z",
              asset_name: null,
            },
          ],
          error: null,
        },
      },
      video_briefs: { select: { data: [], error: null } },
    });
    const { rows } = await buildCreativeRows(admin as never);
    expect(rows[0]?.brief_label).toBe("fedcba98");
    expect(rows[0]?.concept).toBeNull();
  });

  it("surfaces a read error from either table", async () => {
    const admin = mockClient({
      creatives: { select: { data: null, error: { message: "img down" } } },
      video_creatives: { select: { data: [], error: null } },
    });
    const { error } = await buildCreativeRows(admin as never);
    expect(error).toBe("img down");
  });

  it("returns empty rows when both tables are empty", async () => {
    const admin = mockClient({
      creatives: { select: { data: [], error: null } },
      video_creatives: { select: { data: [], error: null } },
    });
    const { rows, error } = await buildCreativeRows(admin as never, { archived: true });
    expect(error).toBeNull();
    expect(rows).toEqual([]);
  });

  it("handles null data + ties in created_at without throwing", async () => {
    const admin = mockClient({
      // data: null on both -> the `?? []` fallbacks; same created_at -> sort tie.
      creatives: {
        select: {
          data: [
            {
              id: "c1",
              brief_id: "b1",
              concept: "A",
              ratio: "1x1",
              status: "draft",
              version: "v1",
              created_at: "2026-01-01T00:00:00Z",
              file_path_supabase: null,
            },
          ],
          error: null,
        },
      },
      video_creatives: {
        select: {
          data: [
            {
              id: "v1",
              brief_id: "b1",
              status: "draft",
              version: 1,
              created_at: "2026-01-01T00:00:00Z",
              asset_name: "B",
            },
          ],
          error: null,
        },
      },
      briefs: { select: { data: null, error: null } },
      video_briefs: { select: { data: null, error: null } },
    });
    const { rows, error } = await buildCreativeRows(admin as never);
    expect(error).toBeNull();
    expect(rows).toHaveLength(2);
    // Both brief labels fall back to the uuid head (briefs lookups returned null).
    expect(rows.every((r) => r.brief_label === "b1".slice(0, 8))).toBe(true);
  });
});
