/**
 * Exemplar API-route test for the parallel Next.js coverage agents.
 *
 * Demonstrates:
 *  - Mocking `@/lib/supabase/admin` so the route runs without a real
 *    Supabase URL / key.
 *  - Driving Vitest mocks per table + verb via the `mockSupabaseClient`
 *    helper.
 *  - Constructing `NextRequest` directly so we don't need a server.
 *  - Covering happy paths + the validation (422) + insert error (500)
 *    branches of POST and the filter + cursor + insert error branches
 *    of GET.
 *
 * The mock for `@/lib/supabase/admin` is created lazily inside `vi.mock`
 * so each test can replace the returned client with a fresh
 * `mockSupabaseClient(...)` and assert on its spies.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { mockSupabaseClient, type SupabaseClientMock } from "@/tests/unit/helpers/supabase-mock";

let currentSupabase: SupabaseClientMock = mockSupabaseClient();

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => currentSupabase,
}));

// Import the route AFTER `vi.mock` so the mocked admin client is wired.
import { GET, POST } from "./route";

function makeRequest(url: string, init: RequestInit = {}): NextRequest {
  return new NextRequest(new Request(url, init));
}

describe("POST /api/pipelines", () => {
  beforeEach(() => {
    currentSupabase = mockSupabaseClient();
  });

  it("creates a pipeline and emits the bootstrap event (201)", async () => {
    currentSupabase = mockSupabaseClient({
      pipelines: {
        insert: {
          data: null,
          error: null,
          single: {
            data: {
              id: "p1",
              status: "configuration",
              format_choice: "image",
              client_id: null,
            },
            error: null,
          },
        },
      },
      pipeline_events: { insert: { data: null, error: null } },
    });

    const res = await POST(
      makeRequest("http://localhost/api/pipelines", {
        method: "POST",
        body: JSON.stringify({ format_choice: "image" }),
        headers: { "content-type": "application/json" },
      }),
    );

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.pipeline.id).toBe("p1");

    // The pipelines insert + pipeline_events insert both fired.
    expect(currentSupabase._spies.from).toHaveBeenCalledWith("pipelines");
    expect(currentSupabase._spies.from).toHaveBeenCalledWith("pipeline_events");
  });

  it("accepts an optional client_id and forwards it to the insert", async () => {
    currentSupabase = mockSupabaseClient({
      pipelines: {
        insert: {
          data: null,
          error: null,
          single: {
            data: {
              id: "p2",
              status: "configuration",
              format_choice: "video",
              client_id: "11111111-1111-4111-8111-111111111111",
            },
            error: null,
          },
        },
      },
      pipeline_events: { insert: { data: null, error: null } },
    });

    const res = await POST(
      makeRequest("http://localhost/api/pipelines", {
        method: "POST",
        body: JSON.stringify({
          format_choice: "video",
          client_id: "11111111-1111-4111-8111-111111111111",
        }),
        headers: { "content-type": "application/json" },
      }),
    );

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.pipeline.client_id).toBe("11111111-1111-4111-8111-111111111111");
  });

  it("returns 422 when format_choice is missing", async () => {
    const res = await POST(
      makeRequest("http://localhost/api/pipelines", {
        method: "POST",
        body: JSON.stringify({}),
        headers: { "content-type": "application/json" },
      }),
    );

    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe("validation_failed");
    expect(Array.isArray(body.issues)).toBe(true);
  });

  it("returns 422 when format_choice is invalid", async () => {
    const res = await POST(
      makeRequest("http://localhost/api/pipelines", {
        method: "POST",
        body: JSON.stringify({ format_choice: "not-a-format" }),
        headers: { "content-type": "application/json" },
      }),
    );

    expect(res.status).toBe(422);
  });

  it("returns 400 on invalid JSON body", async () => {
    const res = await POST(
      makeRequest("http://localhost/api/pipelines", {
        method: "POST",
        body: "this is not json",
        headers: { "content-type": "application/json" },
      }),
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/invalid json/i);
  });

  it("returns 500 when the Supabase insert fails", async () => {
    currentSupabase = mockSupabaseClient({
      pipelines: {
        insert: {
          data: null,
          error: null,
          single: { data: null, error: { message: "duplicate key" } },
        },
      },
    });

    const res = await POST(
      makeRequest("http://localhost/api/pipelines", {
        method: "POST",
        body: JSON.stringify({ format_choice: "image" }),
        headers: { "content-type": "application/json" },
      }),
    );

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("duplicate key");
  });

  it("still returns 201 when the event insert fails (pipeline is the primary artifact)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    currentSupabase = mockSupabaseClient({
      pipelines: {
        insert: {
          data: null,
          error: null,
          single: {
            data: {
              id: "p3",
              status: "configuration",
              format_choice: "both",
              client_id: null,
            },
            error: null,
          },
        },
      },
      pipeline_events: {
        insert: { data: null, error: { message: "events table offline" } },
      },
    });

    const res = await POST(
      makeRequest("http://localhost/api/pipelines", {
        method: "POST",
        body: JSON.stringify({ format_choice: "both" }),
        headers: { "content-type": "application/json" },
      }),
    );

    expect(res.status).toBe(201);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("events table offline"));
    warnSpy.mockRestore();
  });
});

describe("GET /api/pipelines", () => {
  beforeEach(() => {
    currentSupabase = mockSupabaseClient();
  });

  it("lists pipelines and returns next_cursor when the page is full", async () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({
      id: `p${i}`,
      status: "configuration",
      format_choice: "image",
      created_at: `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
    }));
    currentSupabase = mockSupabaseClient({
      pipelines: { select: { data: rows, error: null } },
    });

    const res = await GET(makeRequest("http://localhost/api/pipelines"));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.pipelines).toHaveLength(50);
    expect(body.next_cursor).toBe(rows[49]!.created_at);
  });

  it("returns null next_cursor when the page is under the limit", async () => {
    currentSupabase = mockSupabaseClient({
      pipelines: {
        select: {
          data: [{ id: "p1", status: "done", created_at: "2026-01-01T00:00:00Z" }],
          error: null,
        },
      },
    });

    const res = await GET(makeRequest("http://localhost/api/pipelines"));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.next_cursor).toBeNull();
  });

  it("applies status, client_id, cursor, and limit filters", async () => {
    // Silent-failure PR-4: `?status=` filtering reads derived_status from
    // `v_pipeline_dispatch_state` (the dropped column's replacement). Seed
    // the view with one matching id so the route falls through to the
    // pipelines table call where the other filters land.
    currentSupabase = mockSupabaseClient({
      v_pipeline_dispatch_state: {
        select: { data: [{ pipeline_id: "p1", derived_status: "ideation" }], error: null },
      },
      pipelines: { select: { data: [], error: null } },
    });

    const url =
      "http://localhost/api/pipelines" +
      "?status=ideation" +
      "&client_id=22222222-2222-4222-8222-222222222222" +
      "&cursor=2026-01-01T00:00:00.000Z" +
      "&limit=10";
    const res = await GET(makeRequest(url));

    expect(res.status).toBe(200);

    // Silent-failure PR-4: `?status=` filtering routes through
    // `v_pipeline_dispatch_state.derived_status` (the dropped column's
    // event-sourced replacement). The pipelines table call applies the
    // `client_id` + `cursor` filters + `limit`.
    const fromCalls = currentSupabase._spies.from.mock.calls.map((c) => c[0]);
    expect(fromCalls).toContain("v_pipeline_dispatch_state");
    expect(fromCalls).toContain("pipelines");

    // Find the v_pipeline_dispatch_state chain and assert the derived-status
    // filter landed on it.
    const viewCallIdx = fromCalls.indexOf("v_pipeline_dispatch_state");
    const viewResult = currentSupabase._spies.from.mock.results[viewCallIdx]?.value as
      | Record<string, ReturnType<typeof vi.fn>>
      | undefined;
    const viewChain = viewResult?.select?.mock.results[0]?.value as
      | Record<string, ReturnType<typeof vi.fn>>
      | undefined;
    if (!viewChain) throw new Error("view select() returned no chain");
    expect(viewChain.eq).toHaveBeenCalledWith("derived_status", "ideation");

    // The pipelines call carries client_id + cursor + limit.
    const pipelinesCallIdx = fromCalls.indexOf("pipelines");
    const pipelinesResult = currentSupabase._spies.from.mock.results[pipelinesCallIdx]?.value as
      | Record<string, ReturnType<typeof vi.fn>>
      | undefined;
    const selectChain = pipelinesResult?.select?.mock.results[0]?.value as
      | Record<string, ReturnType<typeof vi.fn>>
      | undefined;
    if (!selectChain) throw new Error("pipelines select() returned no chain");
    expect(selectChain.eq).toHaveBeenCalledWith(
      "client_id",
      "22222222-2222-4222-8222-222222222222",
    );
    expect(selectChain.lt).toHaveBeenCalledWith("created_at", "2026-01-01T00:00:00.000Z");
    expect(selectChain.limit).toHaveBeenCalledWith(10);
  });

  it("excludes archived rows by default (deleted_at is null)", async () => {
    currentSupabase = mockSupabaseClient({
      pipelines: { select: { data: [], error: null } },
    });
    const res = await GET(makeRequest("http://localhost/api/pipelines"));
    expect(res.status).toBe(200);

    const fromResult = currentSupabase._spies.from.mock.results[0]?.value as
      | Record<string, ReturnType<typeof vi.fn>>
      | undefined;
    const selectChain = fromResult?.select?.mock.results[0]?.value as
      | Record<string, ReturnType<typeof vi.fn>>
      | undefined;
    if (!selectChain) throw new Error("select() returned no chain");
    expect(selectChain.is).toHaveBeenCalledWith("deleted_at", null);
    expect(selectChain.not).not.toHaveBeenCalled();
  });

  it("shows only archived rows with ?archived=true (deleted_at is not null)", async () => {
    currentSupabase = mockSupabaseClient({
      pipelines: { select: { data: [], error: null } },
    });
    const res = await GET(makeRequest("http://localhost/api/pipelines?archived=true"));
    expect(res.status).toBe(200);

    const fromResult = currentSupabase._spies.from.mock.results[0]?.value as
      | Record<string, ReturnType<typeof vi.fn>>
      | undefined;
    const selectChain = fromResult?.select?.mock.results[0]?.value as
      | Record<string, ReturnType<typeof vi.fn>>
      | undefined;
    if (!selectChain) throw new Error("select() returned no chain");
    expect(selectChain.not).toHaveBeenCalledWith("deleted_at", "is", null);
    expect(selectChain.is).not.toHaveBeenCalledWith("deleted_at", null);
  });

  it("returns 422 on an invalid status enum value", async () => {
    const res = await GET(makeRequest("http://localhost/api/pipelines?status=not-a-status"));
    expect(res.status).toBe(422);
  });

  it("returns 422 on an invalid limit (over max)", async () => {
    const res = await GET(makeRequest("http://localhost/api/pipelines?limit=9999"));
    expect(res.status).toBe(422);
  });

  it("returns 500 when the Supabase query fails", async () => {
    currentSupabase = mockSupabaseClient({
      pipelines: { select: { data: null, error: { message: "connection refused" } } },
    });

    const res = await GET(makeRequest("http://localhost/api/pipelines"));

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("connection refused");
  });
});
