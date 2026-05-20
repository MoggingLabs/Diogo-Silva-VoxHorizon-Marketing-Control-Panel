import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let result: { data: unknown; error: { message: string } | null } = { data: [], error: null };
const from = vi.fn(() => {
  const c: Record<string, unknown> = {};
  for (const m of ["select", "eq", "order", "limit"]) c[m] = vi.fn(() => c);
  (c as { then: unknown }).then = (onF: (v: typeof result) => unknown) =>
    Promise.resolve(result).then(onF);
  return c;
});
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ from }),
}));

import { GET } from "./route";

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  result = { data: [], error: null };
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET /api/creatives/[id]/iterations", () => {
  it("400s when id is empty", async () => {
    const res = await GET(new Request("http://x") as never, ctx(""));
    expect(res.status).toBe(400);
  });

  it("returns iterations for the creative", async () => {
    result = { data: [{ id: "i1" }], error: null };
    const res = await GET(new Request("http://x") as never, ctx("c1"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ iterations: [{ id: "i1" }] });
    expect(from).toHaveBeenCalledWith("creative_iterations");
  });

  it("defaults to [] when data is null", async () => {
    result = { data: null, error: null };
    const res = await GET(new Request("http://x") as never, ctx("c1"));
    expect(await res.json()).toEqual({ iterations: [] });
  });

  it("500s on a db error", async () => {
    result = { data: null, error: { message: "rls" } };
    const res = await GET(new Request("http://x") as never, ctx("c1"));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("rls");
  });
});
