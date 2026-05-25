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

function getReq(): NextRequest {
  return new NextRequest(new Request(`http://localhost/api/clients/${CLIENT}/integrations`));
}
function postReq(body: unknown): NextRequest {
  return new NextRequest(
    new Request(`http://localhost/api/clients/${CLIENT}/integrations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  currentSupabase = mockClient();
});

describe("GET /api/clients/:id/integrations", () => {
  it("GUARDRAIL: lists integrations with secrets masked", async () => {
    currentSupabase = mockClient({
      client_integrations: {
        select: {
          data: [{ id: "i1", provider: "meta", config: { access_token: "tok-abcdef123456" } }],
        },
      },
    });
    const res = await GET(getReq(), routeContext({ id: CLIENT }));
    expect(res.status).toBe(200);
    const { integrations } = await res.json();
    expect(integrations[0].config.access_token).toBe("********3456");
  });

  it("500s on a db error", async () => {
    currentSupabase = mockClient({
      client_integrations: { select: { data: null, error: { message: "down" } } },
    });
    const res = await GET(getReq(), routeContext({ id: CLIENT }));
    expect(res.status).toBe(500);
  });
});

describe("POST /api/clients/:id/integrations", () => {
  it("GUARDRAIL: creates and returns the row with secrets masked", async () => {
    currentSupabase = mockClient({
      clients: { select: { single: { data: { id: CLIENT }, error: null } } },
      client_integrations: {
        insert: {
          single: {
            data: { id: "i1", provider: "ghl", config: { api_key: "key-zzzz99998888" } },
            error: null,
          },
        },
      },
      events: { insert: { data: null, error: null } },
    });
    const res = await POST(
      postReq({ provider: "ghl", config: { api_key: "key-zzzz99998888" } }),
      routeContext({ id: CLIENT }),
    );
    expect(res.status).toBe(201);
    const { integration } = await res.json();
    expect(integration.config.api_key).toBe("********8888");
  });

  it("404s when the parent client is missing", async () => {
    currentSupabase = mockClient({
      clients: { select: { single: { data: null, error: null } } },
    });
    const res = await POST(postReq({ provider: "meta" }), routeContext({ id: CLIENT }));
    expect(res.status).toBe(404);
  });

  it("400s on an invalid provider", async () => {
    currentSupabase = mockClient({
      clients: { select: { single: { data: { id: CLIENT }, error: null } } },
    });
    const res = await POST(postReq({ provider: "twitter" }), routeContext({ id: CLIENT }));
    expect(res.status).toBe(400);
  });

  it("500s when the client lookup errors", async () => {
    currentSupabase = mockClient({
      clients: { select: { single: { data: null, error: { message: "boom" } } } },
    });
    const res = await POST(postReq({ provider: "meta" }), routeContext({ id: CLIENT }));
    expect(res.status).toBe(500);
  });

  it("500s on a non-unique insert error", async () => {
    currentSupabase = mockClient({
      clients: { select: { single: { data: { id: CLIENT }, error: null } } },
      client_integrations: { insert: { single: { data: null, error: { message: "boom" } } } },
    });
    const res = await POST(postReq({ provider: "meta" }), routeContext({ id: CLIENT }));
    expect(res.status).toBe(500);
  });

  it("409s on a duplicate provider", async () => {
    currentSupabase = mockClient({
      clients: { select: { single: { data: { id: CLIENT }, error: null } } },
      client_integrations: {
        insert: { single: { data: null, error: { message: "duplicate key", code: "23505" } } },
      },
    });
    const res = await POST(postReq({ provider: "meta" }), routeContext({ id: CLIENT }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("provider_taken");
  });
});
