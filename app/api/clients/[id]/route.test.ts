import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { mockClient } from "@/tests/unit/helpers/api-mock";
import { routeContext } from "@/tests/unit/helpers/route-harness";
import { type SupabaseClientMock } from "@/tests/unit/helpers/supabase-mock";

let currentSupabase: SupabaseClientMock = mockClient();

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => currentSupabase,
}));

import { DELETE, GET, PATCH } from "./route";

const ID = "11111111-1111-4111-8111-111111111111";

function getReq(): NextRequest {
  return new NextRequest(new Request(`http://localhost/api/clients/${ID}`));
}
function patchReq(body: unknown): NextRequest {
  return new NextRequest(
    new Request(`http://localhost/api/clients/${ID}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}
function delReq(): NextRequest {
  return new NextRequest(new Request(`http://localhost/api/clients/${ID}`, { method: "DELETE" }));
}

beforeEach(() => {
  currentSupabase = mockClient();
});

describe("GET /api/clients/:id", () => {
  it("returns full detail with children, integrations (masked), and events", async () => {
    currentSupabase = mockClient({
      clients: { select: { single: { data: { id: ID, name: "Acme" }, error: null } } },
      client_profiles: {
        select: { single: { data: { client_id: ID, tone: "warm" }, error: null } },
      },
      client_services: { select: { data: [{ id: "s1", service_name: "Roof repair" }] } },
      client_value_props: { select: { data: [] } },
      client_offers: { select: { data: [] } },
      client_offer_constraints: { select: { data: [] } },
      client_assets: { select: { data: [] } },
      client_past_projects: { select: { data: [] } },
      client_integrations: {
        select: {
          data: [{ id: "i1", provider: "meta", config: { api_key: "supersecretvalue1234" } }],
        },
      },
      events: { select: { data: [{ id: "e1", kind: "client_created" }] } },
    });

    const res = await GET(getReq(), routeContext({ id: ID }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.client).toMatchObject({ id: ID });
    expect(body.profile).toMatchObject({ tone: "warm" });
    expect(body.services).toHaveLength(1);
    expect(body.events).toHaveLength(1);
    // GUARDRAIL: integration config secret is masked in the response.
    expect(body.integrations[0].config.api_key).toBe("********1234");
  });

  it("404s when the client is missing", async () => {
    currentSupabase = mockClient({
      clients: { select: { single: { data: null, error: null } } },
    });
    const res = await GET(getReq(), routeContext({ id: ID }));
    expect(res.status).toBe(404);
  });

  it("500s on a db error", async () => {
    currentSupabase = mockClient({
      clients: { select: { single: { data: null, error: { message: "boom" } } } },
    });
    const res = await GET(getReq(), routeContext({ id: ID }));
    expect(res.status).toBe(500);
  });
});

describe("PATCH /api/clients/:id", () => {
  it("updates fields and emits client_updated", async () => {
    currentSupabase = mockClient({
      clients: {
        select: { single: { data: { id: ID }, error: null } },
        update: { single: { data: { id: ID, name: "Renamed" }, error: null } },
      },
      events: { insert: { data: null, error: null } },
    });
    const res = await PATCH(patchReq({ name: "Renamed" }), routeContext({ id: ID }));
    expect(res.status).toBe(200);
    expect((await res.json()).client).toMatchObject({ name: "Renamed" });
  });

  it("applies every editable field", async () => {
    currentSupabase = mockClient({
      clients: {
        select: { single: { data: { id: ID }, error: null } },
        update: { single: { data: { id: ID }, error: null } },
      },
      events: { insert: { data: null, error: null } },
    });
    const res = await PATCH(
      patchReq({
        slug: "new-slug",
        name: "New Name",
        service_type: "pools",
        status: "paused",
        brand_colors: { primary: "#fff" },
        cpl_target: 50,
        ghl_location_id: "loc",
        meta_account_id: "act_9",
        drive_root_folder_id: "fold",
      }),
      routeContext({ id: ID }),
    );
    expect(res.status).toBe(200);
  });

  it("rejects an empty patch with 400", async () => {
    const res = await PATCH(patchReq({}), routeContext({ id: ID }));
    expect(res.status).toBe(400);
  });

  it("404s when the row is missing", async () => {
    currentSupabase = mockClient({
      clients: { select: { single: { data: null, error: null } } },
    });
    const res = await PATCH(patchReq({ name: "X" }), routeContext({ id: ID }));
    expect(res.status).toBe(404);
  });

  it("returns 409 on a slug collision", async () => {
    currentSupabase = mockClient({
      clients: {
        select: { single: { data: { id: ID }, error: null } },
        update: { single: { data: null, error: { message: "duplicate key", code: "23505" } } },
      },
    });
    const res = await PATCH(patchReq({ slug: "taken-slug" }), routeContext({ id: ID }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("slug_taken");
  });

  it("500s on a non-unique update error", async () => {
    currentSupabase = mockClient({
      clients: {
        select: { single: { data: { id: ID }, error: null } },
        update: { single: { data: null, error: { message: "boom" } } },
      },
    });
    const res = await PATCH(patchReq({ name: "X" }), routeContext({ id: ID }));
    expect(res.status).toBe(500);
  });

  it("500s when the pre-update fetch errors", async () => {
    currentSupabase = mockClient({
      clients: { select: { single: { data: null, error: { message: "boom" } } } },
    });
    const res = await PATCH(patchReq({ name: "X" }), routeContext({ id: ID }));
    expect(res.status).toBe(500);
  });

  it("400s on invalid JSON", async () => {
    const res = await PATCH(patchReq("{bad"), routeContext({ id: ID }));
    expect(res.status).toBe(400);
  });
});

describe("DELETE /api/clients/:id (soft-archive)", () => {
  it("GUARDRAIL: soft-delete sets deleted_at and emits client_archived", async () => {
    currentSupabase = mockClient({
      clients: {
        update: { single: { data: { id: ID, deleted_at: "2025-01-01T00:00:00Z" }, error: null } },
      },
      events: { insert: { data: null, error: null } },
    });
    const res = await DELETE(delReq(), routeContext({ id: ID }));
    expect(res.status).toBe(200);
    const body = await res.json();
    // Soft-delete returns the row with the tombstone set (not a hard delete).
    expect(body.client.deleted_at).not.toBeNull();
    // The audit event is emitted via the events table.
    expect(currentSupabase._spies.from).toHaveBeenCalledWith("events");
  });

  it("404s when the client does not exist", async () => {
    currentSupabase = mockClient({
      clients: {
        update: { single: { data: null, error: null } },
        select: { single: { data: null, error: null } },
      },
    });
    const res = await DELETE(delReq(), routeContext({ id: ID }));
    expect(res.status).toBe(404);
  });

  it("409s when already archived", async () => {
    currentSupabase = mockClient({
      clients: {
        update: { single: { data: null, error: null } },
        select: { single: { data: { id: ID, deleted_at: "2025-01-01T00:00:00Z" }, error: null } },
      },
    });
    const res = await DELETE(delReq(), routeContext({ id: ID }));
    expect(res.status).toBe(409);
  });

  it("500s on a db error during archive", async () => {
    currentSupabase = mockClient({
      clients: { update: { single: { data: null, error: { message: "boom" } } } },
    });
    const res = await DELETE(delReq(), routeContext({ id: ID }));
    expect(res.status).toBe(500);
  });
});
