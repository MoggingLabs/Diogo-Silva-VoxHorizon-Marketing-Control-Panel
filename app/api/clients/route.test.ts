import { afterEach, describe, expect, it, vi } from "vitest";

// Chainable query builder ending in a thenable that resolves `result`.
let result: { data: unknown; error: { message: string } | null } = { data: [], error: null };
const select = vi.fn();
function chain() {
  const c: Record<string, unknown> = {};
  for (const m of ["eq", "order"]) c[m] = vi.fn(() => c);
  c.select = vi.fn((...args: unknown[]) => {
    select(...args);
    return c;
  });
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
  select.mockClear();
  result = { data: [], error: null };
});

describe("GET /api/clients", () => {
  it("returns clients with id/name/slug/service_type/status", async () => {
    const row = {
      id: "c1",
      name: "Acme",
      slug: "acme",
      service_type: "roofing",
      status: "active",
    };
    result = { data: [row], error: null };
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ clients: [row] });
    expect(from).toHaveBeenCalledWith("clients");
    // Selects exactly the picker columns (incl. status).
    expect(select).toHaveBeenCalledWith("id, name, slug, service_type, status");
  });

  it("orders active clients first, then alphabetically by name", async () => {
    result = {
      data: [
        { id: "c3", name: "Zeta", slug: "zeta", service_type: "roofing", status: "active" },
        { id: "c2", name: "Acme", slug: "acme", service_type: "roofing", status: "archived" },
        { id: "c1", name: "Beacon", slug: "beacon", service_type: "roofing", status: "active" },
      ],
      error: null,
    };
    const res = await GET();
    const { clients } = (await res.json()) as { clients: { id: string }[] };
    // Beacon + Zeta (active, alphabetical) before Acme (archived).
    expect(clients.map((c) => c.id)).toEqual(["c1", "c3", "c2"]);
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
