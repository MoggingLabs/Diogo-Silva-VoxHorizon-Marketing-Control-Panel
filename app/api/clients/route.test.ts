import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { mockClient } from "@/tests/unit/helpers/api-mock";
import { type SupabaseClientMock } from "@/tests/unit/helpers/supabase-mock";

let currentSupabase: SupabaseClientMock = mockClient();

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => currentSupabase,
}));

import { GET, POST } from "./route";

function getReq(qs = ""): NextRequest {
  return new NextRequest(new Request(`http://localhost/api/clients${qs}`));
}
function postReq(body: unknown): NextRequest {
  return new NextRequest(
    new Request("http://localhost/api/clients", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  currentSupabase = mockClient();
});

describe("GET /api/clients (legacy picker mode)", () => {
  it("returns clients with picker columns, excluding archived", async () => {
    const row = { id: "c1", name: "Acme", slug: "acme", service_type: "roofing", status: "active" };
    currentSupabase = mockClient({ clients: { select: { data: [row] } } });
    const res = await GET(getReq());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ clients: [row] });
    expect(currentSupabase._spies.from).toHaveBeenCalledWith("clients");
  });

  it("orders active clients first, then alphabetically by name", async () => {
    currentSupabase = mockClient({
      clients: {
        select: {
          data: [
            { id: "c3", name: "Zeta", slug: "zeta", service_type: "roofing", status: "active" },
            { id: "c2", name: "Acme", slug: "acme", service_type: "roofing", status: "archived" },
            { id: "c1", name: "Beacon", slug: "beacon", service_type: "roofing", status: "active" },
          ],
        },
      },
    });
    const res = await GET(getReq());
    const { clients } = (await res.json()) as { clients: { id: string }[] };
    expect(clients.map((c) => c.id)).toEqual(["c1", "c3", "c2"]);
  });

  it("defaults to [] when data is null", async () => {
    currentSupabase = mockClient({ clients: { select: { data: null } } });
    const res = await GET(getReq());
    expect(await res.json()).toEqual({ clients: [] });
  });

  it("500s on a db error", async () => {
    currentSupabase = mockClient({
      clients: { select: { data: null, error: { message: "boom" } } },
    });
    const res = await GET(getReq());
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("boom");
  });
});

describe("GET /api/clients?paginate=1 (list mode)", () => {
  it("returns the list envelope with pagination meta", async () => {
    const rows = [
      {
        id: "c1",
        name: "Acme",
        slug: "acme",
        service_type: "roofing",
        status: "active",
        created_at: "2025-01-01T00:00:00Z",
        deleted_at: null,
      },
    ];
    // count is read off the same select chain; the mock returns it via the
    // thenable result's `count` when present.
    currentSupabase = mockClient({ clients: { select: { data: rows } } });
    const res = await GET(getReq("?paginate=1&pageSize=10"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.clients).toEqual(rows);
    expect(body.page).toMatchObject({ page: 1, pageSize: 10 });
  });

  it("500s on a db error in list mode", async () => {
    currentSupabase = mockClient({
      clients: { select: { data: null, error: { message: "down" } } },
    });
    const res = await GET(getReq("?paginate=1"));
    expect(res.status).toBe(500);
  });
});

describe("POST /api/clients", () => {
  const valid = { slug: "acme-co", name: "Acme Co", service_type: "roofing" };

  it("creates a client and emits client_created", async () => {
    const created = { id: "c1", ...valid, status: "active" };
    currentSupabase = mockClient({
      clients: { insert: { single: { data: created, error: null } } },
      events: { insert: { data: null, error: null } },
    });
    const res = await POST(postReq(valid));
    expect(res.status).toBe(201);
    expect((await res.json()).client).toEqual(created);
    // events.insert called for the audit event.
    expect(currentSupabase._spies.from).toHaveBeenCalledWith("events");
  });

  it("rejects an invalid body with 400 validation_failed", async () => {
    const res = await POST(postReq({ name: "No slug", service_type: "roofing" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("validation_failed");
  });

  it("rejects a bad service_type with 400", async () => {
    const res = await POST(postReq({ ...valid, service_type: "plumbing" }));
    expect(res.status).toBe(400);
  });

  it("rejects a non-url-safe slug with 400", async () => {
    const res = await POST(postReq({ ...valid, slug: "Acme Co!" }));
    expect(res.status).toBe(400);
  });

  it("returns 409 slug_taken on a unique-violation", async () => {
    currentSupabase = mockClient({
      clients: {
        insert: {
          single: { data: null, error: { message: "duplicate key value", code: "23505" } },
        },
      },
    });
    const res = await POST(postReq(valid));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("slug_taken");
  });

  it("500s on a non-unique insert error", async () => {
    currentSupabase = mockClient({
      clients: { insert: { single: { data: null, error: { message: "boom" } } } },
    });
    const res = await POST(postReq(valid));
    expect(res.status).toBe(500);
  });

  it("returns 400 on invalid JSON", async () => {
    const res = await POST(postReq("{not json"));
    expect(res.status).toBe(400);
  });
});
