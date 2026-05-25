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
const CHILD = "22222222-2222-4222-8222-222222222222";

function childCtx() {
  return { params: Promise.resolve({ id: CLIENT, childId: CHILD }) };
}
function patchReq(body: unknown): NextRequest {
  return new NextRequest(
    new Request(`http://localhost/api/clients/${CLIENT}/services/${CHILD}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}
function delReq(): NextRequest {
  return new NextRequest(
    new Request(`http://localhost/api/clients/${CLIENT}/services/${CHILD}`, { method: "DELETE" }),
  );
}

beforeEach(() => {
  currentSupabase = mockClient();
});

describe("PATCH /api/clients/:id/services/:childId", () => {
  it("edits a child row and emits client_service_updated", async () => {
    currentSupabase = mockClient({
      client_services: {
        update: { single: { data: { id: CHILD, service_name: "X" }, error: null } },
      },
      events: { insert: { data: null, error: null } },
    });
    const res = await PATCH(patchReq({ service_name: "X" }), childCtx());
    expect(res.status).toBe(200);
    expect((await res.json()).item).toMatchObject({ service_name: "X" });
  });

  it("404s when the row is missing or already archived", async () => {
    currentSupabase = mockClient({
      client_services: { update: { single: { data: null, error: null } } },
    });
    const res = await PATCH(patchReq({ service_name: "X" }), childCtx());
    expect(res.status).toBe(404);
  });

  it("400s on an empty patch", async () => {
    const res = await PATCH(patchReq({}), childCtx());
    expect(res.status).toBe(400);
  });

  it("400s on invalid JSON", async () => {
    const res = await PATCH(patchReq("{bad"), childCtx());
    expect(res.status).toBe(400);
  });

  it("500s on a db error", async () => {
    currentSupabase = mockClient({
      client_services: { update: { single: { data: null, error: { message: "boom" } } } },
    });
    const res = await PATCH(patchReq({ service_name: "X" }), childCtx());
    expect(res.status).toBe(500);
  });
});

describe("DELETE /api/clients/:id/services/:childId (soft-archive)", () => {
  it("GUARDRAIL: soft-delete sets deleted_at and emits client_service_archived", async () => {
    currentSupabase = mockClient({
      client_services: {
        update: {
          single: { data: { id: CHILD, deleted_at: "2025-01-01T00:00:00Z" }, error: null },
        },
      },
      events: { insert: { data: null, error: null } },
    });
    const res = await DELETE(delReq(), childCtx());
    expect(res.status).toBe(200);
    expect((await res.json()).item.deleted_at).not.toBeNull();
    expect(currentSupabase._spies.from).toHaveBeenCalledWith("events");
  });

  it("409s when already archived", async () => {
    currentSupabase = mockClient({
      client_services: {
        update: { single: { data: null, error: null } },
        select: {
          single: { data: { id: CHILD, deleted_at: "2025-01-01T00:00:00Z" }, error: null },
        },
      },
    });
    const res = await DELETE(delReq(), childCtx());
    expect(res.status).toBe(409);
  });

  it("404s when the row does not exist", async () => {
    currentSupabase = mockClient({
      client_services: {
        update: { single: { data: null, error: null } },
        select: { single: { data: null, error: null } },
      },
    });
    const res = await DELETE(delReq(), childCtx());
    expect(res.status).toBe(404);
  });
});
