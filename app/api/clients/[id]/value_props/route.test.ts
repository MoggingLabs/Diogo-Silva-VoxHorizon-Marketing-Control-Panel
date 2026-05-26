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

const CLIENT = "11111111-1111-4111-8111-111111111111";

function createReq(body: unknown): NextRequest {
  return new NextRequest(
    new Request(`http://localhost/api/clients/${CLIENT}/value_props`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  currentSupabase = mockClient();
});

describe("POST /api/clients/:id/value_props (enum-bearing child)", () => {
  it("accepts a valid kind + prop_text", async () => {
    currentSupabase = mockClient({
      clients: { select: { single: { data: { id: CLIENT }, error: null } } },
      client_value_props: {
        insert: { single: { data: { id: "vp1", kind: "usp", prop_text: "Fast" }, error: null } },
      },
      events: { insert: { data: null, error: null } },
    });
    const res = await POST(
      createReq({ kind: "usp", prop_text: "Fast" }),
      routeContext({ id: CLIENT }),
    );
    expect(res.status).toBe(201);
    expect((await res.json()).item).toMatchObject({ kind: "usp" });
  });

  it("rejects an invalid kind with 400", async () => {
    currentSupabase = mockClient({
      clients: { select: { single: { data: { id: CLIENT }, error: null } } },
    });
    const res = await POST(
      createReq({ kind: "not_a_kind", prop_text: "Fast" }),
      routeContext({ id: CLIENT }),
    );
    expect(res.status).toBe(400);
  });
});
