/**
 * Unit tests for `app/api/briefs/route.ts` (GET + POST).
 *
 * Mirrors the exemplar pattern at `app/api/pipelines/route.test.ts`:
 *  - Mock `@/lib/supabase/admin` to swap in a fresh `mockSupabaseClient`
 *    per test.
 *  - Drive each branch — happy path, zod-fail, client-missing, RPC fail,
 *    insert fail, event-insert fail (non-fatal warn), filter / list paths.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { mockClient } from "@/tests/unit/helpers/api-mock";
import { type SupabaseClientMock } from "@/tests/unit/helpers/supabase-mock";

let currentSupabase: SupabaseClientMock = mockClient();

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => currentSupabase,
}));

// Import the route AFTER `vi.mock` is set up.
import { GET, POST } from "./route";

function makeRequest(url: string, init: RequestInit = {}): NextRequest {
  return new NextRequest(new Request(url, init));
}

/**
 * The briefs route relies on `supabase.rpc("gen_brief_id_human", ...)`. The
 * shared mock helper doesn't model RPCs out of the box, so we patch the
 * returned client per test as needed.
 */
function withRpc(
  client: SupabaseClientMock,
  rpcResult: { data: unknown; error: { message: string } | null },
): SupabaseClientMock {
  (client as unknown as { rpc: ReturnType<typeof vi.fn> }).rpc = vi.fn(() =>
    Promise.resolve(rpcResult),
  );
  return client;
}

const validPayload = {
  service: "roofing",
  budget: 1000,
  market: "Miami",
};

const validBody = {
  client_id: "11111111-1111-4111-8111-111111111111",
  payload: validPayload,
};

describe("GET /api/briefs", () => {
  beforeEach(() => {
    currentSupabase = mockClient();
  });

  it("lists briefs (200)", async () => {
    currentSupabase = mockClient({
      briefs: {
        select: {
          data: [
            {
              id: "b1",
              brief_id_human: "VOX-2026-0001",
              status: "draft",
              created_at: "2026-01-01T00:00:00Z",
            },
          ],
          error: null,
        },
      },
    });

    const res = await GET(makeRequest("http://localhost/api/briefs"));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.briefs).toHaveLength(1);
    expect(currentSupabase._spies.from).toHaveBeenCalledWith("briefs");
  });

  it("applies status + client_id filters", async () => {
    currentSupabase = mockClient({
      briefs: { select: { data: [], error: null } },
    });

    const res = await GET(
      makeRequest(
        "http://localhost/api/briefs?status=posted&client_id=22222222-2222-4222-8222-222222222222",
      ),
    );

    expect(res.status).toBe(200);
    const fromResult = currentSupabase._spies.from.mock.results[0]?.value as
      | Record<string, ReturnType<typeof vi.fn>>
      | undefined;
    if (!fromResult) throw new Error("from() was never called");
    const selectFn = fromResult.select;
    if (!selectFn) throw new Error("from(...).select was never invoked");
    const selectChain = selectFn.mock.results[0]?.value as
      | Record<string, ReturnType<typeof vi.fn>>
      | undefined;
    if (!selectChain) throw new Error("select() returned no chain");
    expect(selectChain.eq).toHaveBeenCalledWith("status", "posted");
    expect(selectChain.eq).toHaveBeenCalledWith(
      "client_id",
      "22222222-2222-4222-8222-222222222222",
    );
  });

  it("returns 500 when supabase errors", async () => {
    currentSupabase = mockClient({
      briefs: { select: { data: null, error: { message: "boom" } } },
    });
    const res = await GET(makeRequest("http://localhost/api/briefs"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("boom");
  });
});

describe("POST /api/briefs", () => {
  beforeEach(() => {
    currentSupabase = mockClient();
  });

  it("creates a draft brief (201)", async () => {
    currentSupabase = withRpc(
      mockClient({
        clients: {
          select: { single: { data: { slug: "acme" }, error: null } },
        },
        briefs: {
          insert: {
            single: {
              data: {
                id: "b1",
                brief_id_human: "ACME-2026-0001",
                client_id: validBody.client_id,
                status: "draft",
              },
              error: null,
            },
          },
        },
        events: { insert: { data: null, error: null } },
      }),
      { data: "ACME-2026-0001", error: null },
    );

    const res = await POST(
      makeRequest("http://localhost/api/briefs", {
        method: "POST",
        body: JSON.stringify(validBody),
        headers: { "content-type": "application/json" },
      }),
    );

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.brief.id).toBe("b1");
  });

  it("posts immediately when ?post=1", async () => {
    currentSupabase = withRpc(
      mockClient({
        clients: {
          select: { single: { data: { slug: "acme" }, error: null } },
        },
        briefs: {
          insert: {
            single: {
              data: {
                id: "b2",
                brief_id_human: "ACME-2026-0002",
                status: "posted",
              },
              error: null,
            },
          },
        },
        events: { insert: { data: null, error: null } },
      }),
      { data: "ACME-2026-0002", error: null },
    );

    const res = await POST(
      makeRequest("http://localhost/api/briefs?post=1", {
        method: "POST",
        body: JSON.stringify(validBody),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.brief.status).toBe("posted");
  });

  it("400 on invalid JSON body", async () => {
    const res = await POST(
      makeRequest("http://localhost/api/briefs", {
        method: "POST",
        body: "not-json",
        headers: { "content-type": "application/json" },
      }),
    );
    expect(res.status).toBe(400);
  });

  it("400 on validation failure", async () => {
    const res = await POST(
      makeRequest("http://localhost/api/briefs", {
        method: "POST",
        body: JSON.stringify({}),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("validation_failed");
  });

  it("500 when clients lookup errors", async () => {
    currentSupabase = mockClient({
      clients: {
        select: { single: { data: null, error: { message: "db down" } } },
      },
    });
    const res = await POST(
      makeRequest("http://localhost/api/briefs", {
        method: "POST",
        body: JSON.stringify(validBody),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("db down");
  });

  it("404 when client doesn't exist", async () => {
    currentSupabase = mockClient({
      clients: { select: { single: { data: null, error: null } } },
    });
    const res = await POST(
      makeRequest("http://localhost/api/briefs", {
        method: "POST",
        body: JSON.stringify(validBody),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("client not found");
  });

  it("500 when RPC fails", async () => {
    currentSupabase = withRpc(
      mockClient({
        clients: {
          select: { single: { data: { slug: "acme" }, error: null } },
        },
      }),
      { data: null, error: { message: "rpc broken" } },
    );
    const res = await POST(
      makeRequest("http://localhost/api/briefs", {
        method: "POST",
        body: JSON.stringify(validBody),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("rpc broken");
  });

  it("500 when RPC returns null", async () => {
    currentSupabase = withRpc(
      mockClient({
        clients: {
          select: { single: { data: { slug: "acme" }, error: null } },
        },
      }),
      { data: null, error: null },
    );
    const res = await POST(
      makeRequest("http://localhost/api/briefs", {
        method: "POST",
        body: JSON.stringify(validBody),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("failed to mint brief_id_human");
  });

  it("500 when briefs insert fails", async () => {
    currentSupabase = withRpc(
      mockClient({
        clients: {
          select: { single: { data: { slug: "acme" }, error: null } },
        },
        briefs: {
          insert: {
            single: { data: null, error: { message: "duplicate" } },
          },
        },
      }),
      { data: "ACME-2026-0003", error: null },
    );
    const res = await POST(
      makeRequest("http://localhost/api/briefs", {
        method: "POST",
        body: JSON.stringify(validBody),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("duplicate");
  });

  it("still returns 201 when event insert fails (warns)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    currentSupabase = withRpc(
      mockClient({
        clients: {
          select: { single: { data: { slug: "acme" }, error: null } },
        },
        briefs: {
          insert: {
            single: {
              data: { id: "b3", brief_id_human: "ACME-2026-0004", status: "draft" },
              error: null,
            },
          },
        },
        events: {
          insert: { data: null, error: { message: "events offline" } },
        },
      }),
      { data: "ACME-2026-0004", error: null },
    );

    const res = await POST(
      makeRequest("http://localhost/api/briefs", {
        method: "POST",
        body: JSON.stringify(validBody),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(res.status).toBe(201);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("events offline"));
    warnSpy.mockRestore();
  });
});
