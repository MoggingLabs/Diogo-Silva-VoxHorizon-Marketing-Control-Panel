import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { mockClient } from "@/tests/unit/helpers/api-mock";
import { type SupabaseClientMock } from "@/tests/unit/helpers/supabase-mock";

let currentSupabase: SupabaseClientMock = mockClient();

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => currentSupabase,
}));

import { DELETE, PATCH } from "./route";

const CLIENT = "11111111-1111-4111-8111-111111111111";
const IG = "33333333-3333-4333-8333-333333333333";

function ctx() {
  return { params: Promise.resolve({ id: CLIENT, integrationId: IG }) };
}
function patchReq(body: unknown): NextRequest {
  return new NextRequest(
    new Request(`http://localhost/api/clients/${CLIENT}/integrations/${IG}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}
function delReq(): NextRequest {
  return new NextRequest(
    new Request(`http://localhost/api/clients/${CLIENT}/integrations/${IG}`, { method: "DELETE" }),
  );
}

beforeEach(() => {
  currentSupabase = mockClient();
});

describe("PATCH /api/clients/:id/integrations/:integrationId", () => {
  it("GUARDRAIL: edits and returns the row with secrets masked", async () => {
    currentSupabase = mockClient({
      client_integrations: {
        update: {
          single: {
            data: { id: IG, provider: "meta", config: { secret: "newsecret4321" }, active: false },
            error: null,
          },
        },
      },
      events: { insert: { data: null, error: null } },
    });
    const res = await PATCH(
      patchReq({ active: false, config: { secret: "newsecret4321" } }),
      ctx(),
    );
    expect(res.status).toBe(200);
    const { integration } = await res.json();
    expect(integration.config.secret).toBe("********4321");
    expect(integration.active).toBe(false);
  });

  it("applies provider + external_id + config + active together", async () => {
    currentSupabase = mockClient({
      client_integrations: {
        update: { single: { data: { id: IG, provider: "drive", config: {} }, error: null } },
      },
      events: { insert: { data: null, error: null } },
    });
    const res = await PATCH(
      patchReq({ provider: "drive", external_id: "fold_1", config: { a: 1 }, active: true }),
      ctx(),
    );
    expect(res.status).toBe(200);
  });

  it("500s on a non-unique db error", async () => {
    currentSupabase = mockClient({
      client_integrations: { update: { single: { data: null, error: { message: "boom" } } } },
    });
    const res = await PATCH(patchReq({ active: true }), ctx());
    expect(res.status).toBe(500);
  });

  it("404s when the row is missing or archived", async () => {
    currentSupabase = mockClient({
      client_integrations: { update: { single: { data: null, error: null } } },
    });
    const res = await PATCH(patchReq({ active: true }), ctx());
    expect(res.status).toBe(404);
  });

  it("400s on an empty patch", async () => {
    const res = await PATCH(patchReq({}), ctx());
    expect(res.status).toBe(400);
  });

  it("409s on a provider collision", async () => {
    currentSupabase = mockClient({
      client_integrations: {
        update: { single: { data: null, error: { message: "duplicate key", code: "23505" } } },
      },
    });
    const res = await PATCH(patchReq({ provider: "drive" }), ctx());
    expect(res.status).toBe(409);
  });
});

describe("DELETE /api/clients/:id/integrations/:integrationId", () => {
  it("GUARDRAIL: soft-archives and returns a masked row", async () => {
    currentSupabase = mockClient({
      client_integrations: {
        update: {
          single: {
            data: { id: IG, deleted_at: "2025-01-01T00:00:00Z", config: { token: "tok-aaaa1111" } },
            error: null,
          },
        },
      },
      events: { insert: { data: null, error: null } },
    });
    const res = await DELETE(delReq(), ctx());
    expect(res.status).toBe(200);
    const { integration } = await res.json();
    expect(integration.deleted_at).not.toBeNull();
    expect(integration.config.token).toBe("********1111");
  });

  it("409s when already archived", async () => {
    currentSupabase = mockClient({
      client_integrations: {
        update: { single: { data: null, error: null } },
        select: { single: { data: { id: IG, deleted_at: "2025-01-01T00:00:00Z" }, error: null } },
      },
    });
    const res = await DELETE(delReq(), ctx());
    expect(res.status).toBe(409);
  });
});
