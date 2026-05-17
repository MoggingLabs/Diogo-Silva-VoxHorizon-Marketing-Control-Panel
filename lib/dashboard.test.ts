import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_FORMAT,
  FORMAT_VALUES,
  FUNNEL_STAGES,
  KANBAN_STAGES,
  STAGE_BAR_COLORS,
  STAGE_DOT_COLORS,
  STAGE_LABELS,
  parseFormat,
  zeroCounts,
} from "./dashboard-types";

// `lib/dashboard.ts` is `server-only` — mock that sentinel and the Supabase
// client factory so we can exercise the snapshot loader in node tests.
vi.mock("server-only", () => ({}));

const currentSupabase = {
  from: vi.fn(),
};

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => currentSupabase,
}));

describe("dashboard-types exports", () => {
  it("FORMAT_VALUES is image | video | both", () => {
    expect(FORMAT_VALUES).toEqual(["image", "video", "both"]);
    expect(DEFAULT_FORMAT).toBe("both");
  });

  it("parseFormat normalises invalid values to the default", () => {
    expect(parseFormat("image")).toBe("image");
    expect(parseFormat("video")).toBe("video");
    expect(parseFormat("both")).toBe("both");
    expect(parseFormat("bogus")).toBe("both");
    expect(parseFormat(null)).toBe("both");
    expect(parseFormat(undefined)).toBe("both");
  });

  it("FUNNEL_STAGES + KANBAN_STAGES are aligned with their tables", () => {
    expect(FUNNEL_STAGES).toEqual([
      "in_brief",
      "in_creative",
      "in_copy",
      "in_launch",
      "live",
      "killed",
    ]);
    expect(KANBAN_STAGES).toEqual(["in_brief", "in_creative", "in_copy", "in_launch", "live"]);
    expect(STAGE_LABELS.in_brief).toBe("In Brief");
    expect(STAGE_BAR_COLORS.in_brief).toMatch(/bg-/);
    expect(STAGE_DOT_COLORS.in_brief).toMatch(/bg-/);
  });

  it("zeroCounts produces a baseline FunnelCounts", () => {
    expect(zeroCounts()).toEqual({
      in_brief: 0,
      in_creative: 0,
      in_copy: 0,
      in_launch: 0,
      live: 0,
      killed: 0,
    });
  });
});

/**
 * A chainable Supabase mock that records what `select` was asked for and
 * returns whichever response we scripted last. This mirrors the
 * `lib/dashboard.ts` query shape: count-then-row-fetch per table.
 */
function makeFromMock(
  table: string,
  scripts: {
    count?: { data?: unknown; error?: { message: string } | null; count?: number } | null;
    rows?: { data?: unknown; error?: { message: string } | null } | null;
  } = {},
) {
  const chain = {
    select: vi.fn((_cols: string, opts?: { count?: string; head?: boolean }) => {
      // If `head` is set, this is the count path.
      if (opts?.head && opts.count) {
        const promise = {
          in: vi.fn(() =>
            Promise.resolve({
              data: scripts.count?.data ?? null,
              error: scripts.count?.error ?? null,
              count: scripts.count?.count ?? 0,
            }),
          ),
        };
        return promise;
      }
      // Otherwise this is the row-fetch path.
      const builder: Record<string, unknown> = {};
      builder.in = vi.fn(() => builder);
      builder.order = vi.fn(() => builder);
      builder.limit = vi.fn(() =>
        Promise.resolve({
          data: scripts.rows?.data ?? null,
          error: scripts.rows?.error ?? null,
        }),
      );
      return builder;
    }),
    _table: table,
  };
  return chain;
}

beforeEach(() => {
  currentSupabase.from.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("getDashboardSnapshot", () => {
  it("returns counts + briefs for format=both", async () => {
    const briefRow = {
      id: "b1",
      brief_id_human: "br-1",
      status: "draft",
      created_at: "2026-05-17T00:00:00Z",
      posted_at: null,
      decided_at: null,
      clients: { id: "c1", slug: "acme", name: "Acme" },
    };
    const videoRow = {
      id: "v1",
      brief_id_human: "vb-1",
      status: "posted",
      created_at: "2026-05-17T00:00:00Z",
      posted_at: "2026-05-17T01:00:00Z",
      decided_at: null,
      clients: [{ id: "c2", slug: "beta", name: "Beta" }],
    };

    currentSupabase.from.mockImplementation((table: string) => {
      if (table === "briefs") {
        return makeFromMock("briefs", {
          count: { count: 7, error: null },
          rows: { data: [briefRow], error: null },
        });
      }
      if (table === "video_briefs") {
        return makeFromMock("video_briefs", {
          count: { count: 3, error: null },
          rows: { data: [videoRow], error: null },
        });
      }
      return makeFromMock(table);
    });

    const { getDashboardSnapshot } = await import("./dashboard");
    const snap = await getDashboardSnapshot("both");

    expect(snap.format).toBe("both");
    expect(snap.counts.image.in_brief).toBe(7);
    expect(snap.counts.video.in_brief).toBe(3);
    expect(snap.counts.combined.in_brief).toBe(10);
    expect(snap.image_briefs[0]?.client?.name).toBe("Acme");
    // Array-shaped clients return their first row.
    expect(snap.video_briefs[0]?.client?.name).toBe("Beta");
    expect(snap.errors).toEqual({});
  });

  it("surfaces count + row errors per track", async () => {
    currentSupabase.from.mockImplementation((table: string) => {
      if (table === "briefs") {
        return makeFromMock("briefs", {
          count: { error: { message: "count-img" } },
          rows: { error: { message: "rows-img" } },
        });
      }
      return makeFromMock("video_briefs", {
        count: { error: { message: "count-vid" } },
        rows: { error: { message: "rows-vid" } },
      });
    });

    const { getDashboardSnapshot } = await import("./dashboard");
    const snap = await getDashboardSnapshot("both");
    // Row errors are written last and shadow the count errors.
    expect(snap.errors.image).toBe("rows-img");
    expect(snap.errors.video).toBe("rows-vid");
  });

  it("skips the video row fetch when format=image", async () => {
    let videoCalls = 0;
    currentSupabase.from.mockImplementation((table: string) => {
      if (table === "video_briefs") {
        videoCalls++;
        return makeFromMock("video_briefs", { count: { count: 0, error: null } });
      }
      return makeFromMock("briefs", {
        count: { count: 0, error: null },
        rows: { data: [], error: null },
      });
    });

    const { getDashboardSnapshot } = await import("./dashboard");
    const snap = await getDashboardSnapshot("image");
    expect(snap.video_briefs).toEqual([]);
    // The count still happens (one call), but no row-fetch follows.
    expect(videoCalls).toBe(1);
  });

  it("skips the image row fetch when format=video", async () => {
    currentSupabase.from.mockImplementation((table: string) => {
      if (table === "briefs") {
        return makeFromMock("briefs", { count: { count: 1, error: null } });
      }
      return makeFromMock("video_briefs", {
        count: { count: 0, error: null },
        rows: { data: [], error: null },
      });
    });

    const { getDashboardSnapshot } = await import("./dashboard");
    const snap = await getDashboardSnapshot("video");
    expect(snap.image_briefs).toEqual([]);
    expect(snap.video_briefs).toEqual([]);
  });

  it("treats missing client fields as null", async () => {
    currentSupabase.from.mockImplementation((table: string) => {
      if (table === "briefs") {
        return makeFromMock("briefs", {
          count: { count: 1, error: null },
          rows: {
            data: [
              {
                id: "b",
                brief_id_human: "br-x",
                status: "draft",
                created_at: "2026-05-17T00:00:00Z",
                posted_at: null,
                decided_at: null,
                clients: { id: "c1", slug: "", name: "" }, // missing slug/name
              },
              {
                id: "b2",
                brief_id_human: "br-y",
                status: "draft",
                created_at: "2026-05-17T00:00:00Z",
                posted_at: null,
                decided_at: null,
                clients: null,
              },
            ],
            error: null,
          },
        });
      }
      return makeFromMock("video_briefs", { count: { count: 0, error: null } });
    });

    const { getDashboardSnapshot } = await import("./dashboard");
    const snap = await getDashboardSnapshot("image");
    expect(snap.image_briefs[0]?.client).toBeNull();
    expect(snap.image_briefs[1]?.client).toBeNull();
  });
});
