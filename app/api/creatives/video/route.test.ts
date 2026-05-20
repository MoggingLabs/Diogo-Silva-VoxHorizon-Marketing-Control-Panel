import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const results: Record<string, { data: unknown; error: { message: string } | null }> = {
  video_creatives: { data: [], error: null },
  video_briefs: { data: [], error: null },
};

function chain(table: string) {
  const c: Record<string, unknown> = {};
  c.select = vi.fn(() => c);
  c.order = vi.fn(() => c);
  c.eq = vi.fn(() => c);
  c.in = vi.fn(() => c);
  (c as { then: unknown }).then = (onF: (v: (typeof results)[string]) => unknown) =>
    Promise.resolve(results[table]!).then(onF);
  return c;
}
const from = vi.fn((table: string) => chain(table));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ from }),
}));

import { GET } from "./route";

function req(qs: string): Request {
  return new Request(`http://x/api/creatives/video${qs}`);
}

beforeEach(() => {
  results.video_creatives = { data: [], error: null };
  results.video_briefs = { data: [], error: null };
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET /api/creatives/video", () => {
  it("queries by brief_id", async () => {
    results.video_creatives = { data: [{ id: "v1" }], error: null };
    const res = await GET(req("?brief_id=b1") as never);
    expect(await res.json()).toEqual({ creatives: [{ id: "v1" }] });
  });

  it("500s on a brief_id query error", async () => {
    results.video_creatives = { data: null, error: { message: "rls" } };
    const res = await GET(req("?brief_id=b1") as never);
    expect(res.status).toBe(500);
  });

  it("queries by ids without outlines", async () => {
    results.video_creatives = { data: [{ id: "v1" }], error: null };
    const res = await GET(req("?ids=v1") as never);
    expect(await res.json()).toEqual({ creatives: [{ id: "v1" }] });
  });

  it("returns empty (with outlines) when ids has only separators", async () => {
    const res = await GET(req("?ids=,,&with_outline=1") as never);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ creatives: [], outlines: {} });
  });

  it("treats an empty ?ids= as no selector → 400", async () => {
    const res = await GET(req("?ids=&with_outline=1") as never);
    expect(res.status).toBe(400);
  });

  it("500s on an ids query error", async () => {
    results.video_creatives = { data: null, error: { message: "boom" } };
    const res = await GET(req("?ids=v1") as never);
    expect(res.status).toBe(500);
  });

  it("includes outlines keyed by brief_id when with_outline=1", async () => {
    results.video_creatives = { data: [{ id: "v1", brief_id: "b1" }], error: null };
    results.video_briefs = { data: [{ id: "b1", script_outline: { hook: "h" } }], error: null };
    const res = await GET(req("?ids=v1&with_outline=1") as never);
    expect(await res.json()).toEqual({
      creatives: [{ id: "v1", brief_id: "b1" }],
      outlines: { b1: { hook: "h" } },
    });
  });

  it("500s when the outline lookup errors", async () => {
    results.video_creatives = { data: [{ id: "v1", brief_id: "b1" }], error: null };
    results.video_briefs = { data: null, error: { message: "outline boom" } };
    const res = await GET(req("?ids=v1&with_outline=1") as never);
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("outline boom");
  });

  it("with_outline but no brief ids → empty outlines map", async () => {
    results.video_creatives = { data: [{ id: "v1" }], error: null };
    const res = await GET(req("?ids=v1&with_outline=1") as never);
    expect(await res.json()).toEqual({ creatives: [{ id: "v1" }], outlines: {} });
  });

  it("400s when neither brief_id nor ids is provided", async () => {
    const res = await GET(req("") as never);
    expect(res.status).toBe(400);
  });
});
