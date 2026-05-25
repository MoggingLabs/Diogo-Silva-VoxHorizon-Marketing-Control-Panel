import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { mockClient } from "@/tests/unit/helpers/api-mock";
import { routeContext } from "@/tests/unit/helpers/route-harness";
import { type SupabaseClientMock } from "@/tests/unit/helpers/supabase-mock";

let currentSupabase: SupabaseClientMock = mockClient();

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => currentSupabase,
}));

import { POST } from "./route";

const ID = "11111111-1111-4111-8111-111111111111";

function req(): NextRequest {
  return new NextRequest(
    new Request(`http://localhost/api/clients/${ID}/restore`, { method: "POST" }),
  );
}

beforeEach(() => {
  currentSupabase = mockClient();
});

describe("POST /api/clients/:id/restore", () => {
  it("GUARDRAIL: restore clears deleted_at and emits client_restored", async () => {
    currentSupabase = mockClient({
      clients: { update: { single: { data: { id: ID, deleted_at: null }, error: null } } },
      events: { insert: { data: null, error: null } },
    });
    const res = await POST(req(), routeContext({ id: ID }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.client.deleted_at).toBeNull();
    expect(currentSupabase._spies.from).toHaveBeenCalledWith("events");
  });

  it("409s when the client is already live (not archived)", async () => {
    currentSupabase = mockClient({
      clients: {
        update: { single: { data: null, error: null } },
        select: { single: { data: { id: ID, deleted_at: null }, error: null } },
      },
    });
    const res = await POST(req(), routeContext({ id: ID }));
    expect(res.status).toBe(409);
  });

  it("404s when the client does not exist", async () => {
    currentSupabase = mockClient({
      clients: {
        update: { single: { data: null, error: null } },
        select: { single: { data: null, error: null } },
      },
    });
    const res = await POST(req(), routeContext({ id: ID }));
    expect(res.status).toBe(404);
  });

  it("500s on a db error", async () => {
    currentSupabase = mockClient({
      clients: { update: { single: { data: null, error: { message: "boom" } } } },
    });
    const res = await POST(req(), routeContext({ id: ID }));
    expect(res.status).toBe(500);
  });
});
