import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { mockClient } from "@/tests/unit/helpers/api-mock";
import { routeContext } from "@/tests/unit/helpers/route-harness";
import { type SupabaseClientMock } from "@/tests/unit/helpers/supabase-mock";

let currentSupabase: SupabaseClientMock = mockClient();

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => currentSupabase,
}));

import { GET, POST } from "./route";

const CLIENT = "11111111-1111-4111-8111-111111111111";

function listReq(qs = ""): NextRequest {
  return new NextRequest(new Request(`http://localhost/api/clients/${CLIENT}/services${qs}`));
}
function createReq(body: unknown): NextRequest {
  return new NextRequest(
    new Request(`http://localhost/api/clients/${CLIENT}/services`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  currentSupabase = mockClient();
});

describe("GET /api/clients/:id/services (child list)", () => {
  it("returns the items list envelope", async () => {
    currentSupabase = mockClient({
      client_services: { select: { data: [{ id: "s1", service_name: "Roof repair" }] } },
    });
    const res = await GET(listReq("?pageSize=5"), routeContext({ id: CLIENT }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toHaveLength(1);
    expect(body.page).toMatchObject({ page: 1, pageSize: 5 });
  });

  it("500s on a db error", async () => {
    currentSupabase = mockClient({
      client_services: { select: { data: null, error: { message: "down" } } },
    });
    const res = await GET(listReq(), routeContext({ id: CLIENT }));
    expect(res.status).toBe(500);
  });
});

describe("POST /api/clients/:id/services (child create)", () => {
  it("creates a child row and emits client_service_created", async () => {
    currentSupabase = mockClient({
      clients: { select: { single: { data: { id: CLIENT }, error: null } } },
      client_services: {
        insert: { single: { data: { id: "s1", service_name: "Roofing" }, error: null } },
      },
      events: { insert: { data: null, error: null } },
    });
    const res = await POST(createReq({ service_name: "Roofing" }), routeContext({ id: CLIENT }));
    expect(res.status).toBe(201);
    expect((await res.json()).item).toMatchObject({ service_name: "Roofing" });
    expect(currentSupabase._spies.from).toHaveBeenCalledWith("events");
  });

  it("404s when the parent client is missing", async () => {
    currentSupabase = mockClient({
      clients: { select: { single: { data: null, error: null } } },
    });
    const res = await POST(createReq({ service_name: "Roofing" }), routeContext({ id: CLIENT }));
    expect(res.status).toBe(404);
  });

  it("400s on an invalid body", async () => {
    currentSupabase = mockClient({
      clients: { select: { single: { data: { id: CLIENT }, error: null } } },
    });
    const res = await POST(createReq({ service_name: "" }), routeContext({ id: CLIENT }));
    expect(res.status).toBe(400);
  });

  it("400s on invalid JSON", async () => {
    const res = await POST(createReq("{bad"), routeContext({ id: CLIENT }));
    expect(res.status).toBe(400);
  });

  it("500s when the parent-client lookup errors", async () => {
    currentSupabase = mockClient({
      clients: { select: { single: { data: null, error: { message: "boom" } } } },
    });
    const res = await POST(createReq({ service_name: "Roofing" }), routeContext({ id: CLIENT }));
    expect(res.status).toBe(500);
  });

  it("500s when the insert fails", async () => {
    currentSupabase = mockClient({
      clients: { select: { single: { data: { id: CLIENT }, error: null } } },
      client_services: { insert: { single: { data: null, error: { message: "insert boom" } } } },
    });
    const res = await POST(createReq({ service_name: "Roofing" }), routeContext({ id: CLIENT }));
    expect(res.status).toBe(500);
  });
});
