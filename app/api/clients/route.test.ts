import { afterEach, describe, expect, it, vi } from "vitest";

// Chainable query builder ending in a thenable that resolves `result`.
let result: { data: unknown; error: { message: string } | null } = { data: [], error: null };
function chain() {
  const c: Record<string, unknown> = {};
  for (const m of ["select", "eq", "order"]) c[m] = vi.fn(() => c);
  (c as { then: unknown }).then = (onF: (v: typeof result) => unknown) =>
    Promise.resolve(result).then(onF);
  return c;
}
const from = vi.fn(() => chain());
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ from }),
}));

import { GET } from "./route";

afterEach(() => {
  vi.restoreAllMocks();
  result = { data: [], error: null };
});

describe("GET /api/clients", () => {
  it("returns active clients", async () => {
    result = { data: [{ id: "c1", name: "Acme" }], error: null };
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ clients: [{ id: "c1", name: "Acme" }] });
    expect(from).toHaveBeenCalledWith("clients");
  });

  it("defaults to [] when data is null", async () => {
    result = { data: null, error: null };
    const res = await GET();
    expect(await res.json()).toEqual({ clients: [] });
  });

  it("500s on a db error", async () => {
    result = { data: null, error: { message: "boom" } };
    const res = await GET();
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("boom");
  });
});
