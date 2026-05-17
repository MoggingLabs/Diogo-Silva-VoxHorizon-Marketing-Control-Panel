import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const adminFromSpy = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ from: adminFromSpy }),
}));

function makeChain(result: { data: unknown; error: { message: string } | null }) {
  const order = vi.fn(() => Promise.resolve(result));
  const or = vi.fn(() => ({ order }));
  const select = vi.fn(() => ({ or }));
  adminFromSpy.mockReturnValue({ select });
  return { select, or, order };
}

beforeEach(() => {
  adminFromSpy.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("findPipelinesForBriefs", () => {
  it("short-circuits to empty maps when both lists are empty", async () => {
    const { findPipelinesForBriefs } = await import("./lookup");
    const out = await findPipelinesForBriefs([], []);
    expect(out.image.size).toBe(0);
    expect(out.video.size).toBe(0);
    expect(adminFromSpy).not.toHaveBeenCalled();
  });

  it("returns image map when only image briefs are passed", async () => {
    const chain = makeChain({
      data: [{ id: "p1", image_brief_id: "b1", video_brief_id: null, created_at: "x" }],
      error: null,
    });
    const { findPipelinesForBriefs } = await import("./lookup");
    const out = await findPipelinesForBriefs(["b1"], []);
    expect(out.image.get("b1")).toBe("p1");
    // Only the image clause should be in the OR.
    expect(chain.or).toHaveBeenCalledWith(expect.stringContaining("image_brief_id.in.(b1)"));
  });

  it("returns both maps when both lists are passed", async () => {
    makeChain({
      data: [
        { id: "p1", image_brief_id: "b1", video_brief_id: null, created_at: "1" },
        { id: "p2", image_brief_id: null, video_brief_id: "v1", created_at: "2" },
      ],
      error: null,
    });
    const { findPipelinesForBriefs } = await import("./lookup");
    const out = await findPipelinesForBriefs(["b1"], ["v1"]);
    expect(out.image.get("b1")).toBe("p1");
    expect(out.video.get("v1")).toBe("p2");
  });

  it("returns empty maps when the DB query errors", async () => {
    makeChain({ data: null, error: { message: "boom" } });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { findPipelinesForBriefs } = await import("./lookup");
    const out = await findPipelinesForBriefs(["b1"], []);
    expect(out.image.size).toBe(0);
    expect(warn).toHaveBeenCalled();
  });

  it("uses the most-recent pipeline (last wins) when duplicates exist", async () => {
    // ASC-sorted results are filled into the map, so the LAST row overwrites.
    makeChain({
      data: [
        { id: "old", image_brief_id: "b1", video_brief_id: null, created_at: "1" },
        { id: "new", image_brief_id: "b1", video_brief_id: null, created_at: "2" },
      ],
      error: null,
    });
    const { findPipelinesForBriefs } = await import("./lookup");
    const out = await findPipelinesForBriefs(["b1"], []);
    expect(out.image.get("b1")).toBe("new");
  });

  it("ignores rows whose brief id isn't in the input set", async () => {
    makeChain({
      data: [{ id: "p1", image_brief_id: "different", video_brief_id: null, created_at: "1" }],
      error: null,
    });
    const { findPipelinesForBriefs } = await import("./lookup");
    const out = await findPipelinesForBriefs(["b1"], []);
    expect(out.image.has("b1")).toBe(false);
  });

  it("returns empty maps when DB returns null data", async () => {
    makeChain({ data: null, error: null });
    const { findPipelinesForBriefs } = await import("./lookup");
    const out = await findPipelinesForBriefs(["b1"], []);
    expect(out.image.size).toBe(0);
  });
});
