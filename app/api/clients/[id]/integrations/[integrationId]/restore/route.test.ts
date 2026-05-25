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
const IG = "33333333-3333-4333-8333-333333333333";

function ctx() {
  return { params: Promise.resolve({ id: CLIENT, integrationId: IG }) };
}
function req(): NextRequest {
  return new NextRequest(
    new Request(`http://localhost/api/clients/${CLIENT}/integrations/${IG}/restore`, {
      method: "POST",
    }),
  );
}

beforeEach(() => {
  currentSupabase = mockClient();
});

describe("POST /api/clients/:id/integrations/:integrationId/restore", () => {
  it("GUARDRAIL: restores and returns a masked row", async () => {
    currentSupabase = mockClient({
      client_integrations: {
        update: {
          single: {
            data: { id: IG, deleted_at: null, config: { key: "secretval1234" } },
            error: null,
          },
        },
      },
      events: { insert: { data: null, error: null } },
    });
    const res = await POST(req(), ctx());
    expect(res.status).toBe(200);
    const { integration } = await res.json();
    expect(integration.deleted_at).toBeNull();
    expect(integration.config.key).toBe("********1234");
  });

  it("409s when already live", async () => {
    currentSupabase = mockClient({
      client_integrations: {
        update: { single: { data: null, error: null } },
        select: { single: { data: { id: IG, deleted_at: null }, error: null } },
      },
    });
    const res = await POST(req(), ctx());
    expect(res.status).toBe(409);
  });

  it("404s when the row does not exist", async () => {
    currentSupabase = mockClient({
      client_integrations: {
        update: { single: { data: null, error: null } },
        select: { single: { data: null, error: null } },
      },
    });
    const res = await POST(req(), ctx());
    expect(res.status).toBe(404);
  });

  it("500s on a db error", async () => {
    currentSupabase = mockClient({
      client_integrations: { update: { single: { data: null, error: { message: "boom" } } } },
    });
    const res = await POST(req(), ctx());
    expect(res.status).toBe(500);
  });
});
