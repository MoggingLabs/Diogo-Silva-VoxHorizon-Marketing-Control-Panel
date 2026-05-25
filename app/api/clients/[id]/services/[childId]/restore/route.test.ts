import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { mockClient } from "@/tests/unit/helpers/api-mock";
import { type SupabaseClientMock } from "@/tests/unit/helpers/supabase-mock";

let currentSupabase: SupabaseClientMock = mockClient();

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => currentSupabase,
}));

import { POST } from "./route";

const CLIENT = "11111111-1111-4111-8111-111111111111";
const CHILD = "22222222-2222-4222-8222-222222222222";

function ctx() {
  return { params: Promise.resolve({ id: CLIENT, childId: CHILD }) };
}
function req(): NextRequest {
  return new NextRequest(
    new Request(`http://localhost/api/clients/${CLIENT}/services/${CHILD}/restore`, {
      method: "POST",
    }),
  );
}

beforeEach(() => {
  currentSupabase = mockClient();
});

describe("POST /api/clients/:id/services/:childId/restore", () => {
  it("GUARDRAIL: restore clears deleted_at and emits client_service_restored", async () => {
    currentSupabase = mockClient({
      client_services: {
        update: { single: { data: { id: CHILD, deleted_at: null }, error: null } },
      },
      events: { insert: { data: null, error: null } },
    });
    const res = await POST(req(), ctx());
    expect(res.status).toBe(200);
    expect((await res.json()).item.deleted_at).toBeNull();
    expect(currentSupabase._spies.from).toHaveBeenCalledWith("events");
  });

  it("409s when the row is already live", async () => {
    currentSupabase = mockClient({
      client_services: {
        update: { single: { data: null, error: null } },
        select: { single: { data: { id: CHILD, deleted_at: null }, error: null } },
      },
    });
    const res = await POST(req(), ctx());
    expect(res.status).toBe(409);
  });

  it("404s when the row does not exist", async () => {
    currentSupabase = mockClient({
      client_services: {
        update: { single: { data: null, error: null } },
        select: { single: { data: null, error: null } },
      },
    });
    const res = await POST(req(), ctx());
    expect(res.status).toBe(404);
  });
});
