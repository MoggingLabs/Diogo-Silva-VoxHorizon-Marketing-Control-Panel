import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { mockClient } from "@/tests/unit/helpers/api-mock";
import { routeContext } from "@/tests/unit/helpers/route-harness";
import { type SupabaseClientMock } from "@/tests/unit/helpers/supabase-mock";

let currentSupabase: SupabaseClientMock = mockClient();

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => currentSupabase,
}));

import { GET, PUT } from "./route";

const CLIENT = "11111111-1111-4111-8111-111111111111";

function getReq(): NextRequest {
  return new NextRequest(new Request(`http://localhost/api/clients/${CLIENT}/profile`));
}
function putReq(body: unknown): NextRequest {
  return new NextRequest(
    new Request(`http://localhost/api/clients/${CLIENT}/profile`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  currentSupabase = mockClient();
});

describe("GET /api/clients/:id/profile", () => {
  it("returns the profile when present", async () => {
    currentSupabase = mockClient({
      client_profiles: {
        select: { single: { data: { client_id: CLIENT, tone: "warm" }, error: null } },
      },
    });
    const res = await GET(getReq(), routeContext({ id: CLIENT }));
    expect(res.status).toBe(200);
    expect((await res.json()).profile).toMatchObject({ tone: "warm" });
  });

  it("returns { profile: null } (200) when none exists", async () => {
    currentSupabase = mockClient({
      client_profiles: { select: { single: { data: null, error: null } } },
    });
    const res = await GET(getReq(), routeContext({ id: CLIENT }));
    expect(res.status).toBe(200);
    expect((await res.json()).profile).toBeNull();
  });

  it("500s on a db error", async () => {
    currentSupabase = mockClient({
      client_profiles: { select: { single: { data: null, error: { message: "boom" } } } },
    });
    const res = await GET(getReq(), routeContext({ id: CLIENT }));
    expect(res.status).toBe(500);
  });
});

describe("PUT /api/clients/:id/profile (1:1 upsert)", () => {
  it("upserts the profile and emits client_profile_updated", async () => {
    currentSupabase = mockClient({
      clients: { select: { single: { data: { id: CLIENT }, error: null } } },
      client_profiles: {
        insert: { single: { data: { client_id: CLIENT, tone: "bold" }, error: null } },
      },
      events: { insert: { data: null, error: null } },
    });
    const res = await PUT(putReq({ tone: "bold" }), routeContext({ id: CLIENT }));
    expect(res.status).toBe(200);
    expect((await res.json()).profile).toMatchObject({ tone: "bold" });
    expect(currentSupabase._spies.from).toHaveBeenCalledWith("events");
  });

  it("404s when the parent client is missing", async () => {
    currentSupabase = mockClient({
      clients: { select: { single: { data: null, error: null } } },
    });
    const res = await PUT(putReq({ tone: "bold" }), routeContext({ id: CLIENT }));
    expect(res.status).toBe(404);
  });

  it("400s on an invalid numeric field", async () => {
    const res = await PUT(putReq({ years_in_business: "lots" }), routeContext({ id: CLIENT }));
    expect(res.status).toBe(400);
  });

  it("400s on invalid JSON", async () => {
    const res = await PUT(putReq("{bad"), routeContext({ id: CLIENT }));
    expect(res.status).toBe(400);
  });

  it("500s when the client lookup errors", async () => {
    currentSupabase = mockClient({
      clients: { select: { single: { data: null, error: { message: "boom" } } } },
    });
    const res = await PUT(putReq({ tone: "x" }), routeContext({ id: CLIENT }));
    expect(res.status).toBe(500);
  });

  it("500s when the upsert fails", async () => {
    currentSupabase = mockClient({
      clients: { select: { single: { data: { id: CLIENT }, error: null } } },
      client_profiles: { insert: { single: { data: null, error: { message: "boom" } } } },
    });
    const res = await PUT(putReq({ tone: "x" }), routeContext({ id: CLIENT }));
    expect(res.status).toBe(500);
  });
});
