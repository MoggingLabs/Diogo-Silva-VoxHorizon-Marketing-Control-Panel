import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { mockSupabaseClient, type SupabaseClientMock } from "@/tests/unit/helpers/supabase-mock";

let currentSupabase: SupabaseClientMock = mockSupabaseClient();

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => currentSupabase,
}));

import { GET } from "./route";

function makeRequest(url: string): NextRequest {
  return new NextRequest(new Request(url));
}

describe("GET /api/approvals", () => {
  beforeEach(() => {
    currentSupabase = mockSupabaseClient();
  });

  it("returns the rows (default: pending only)", async () => {
    currentSupabase = mockSupabaseClient({
      approvals: {
        select: {
          data: [{ id: "a1", status: "pending" }],
          error: null,
        },
      },
    });

    const res = await GET(makeRequest("http://localhost/api/approvals"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.approvals).toEqual([
      { id: "a1", status: "pending", pipeline_id: null, client_name: null },
    ]);
  });

  it("returns 422 on an invalid status value", async () => {
    const res = await GET(makeRequest("http://localhost/api/approvals?status=garbage"));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe("validation_failed");
  });

  it("returns 422 on a limit over the cap", async () => {
    const res = await GET(makeRequest("http://localhost/api/approvals?limit=99999"));
    expect(res.status).toBe(422);
  });

  it("applies status/session/tool/decision filters to the query", async () => {
    currentSupabase = mockSupabaseClient({
      approvals: { select: { data: [], error: null } },
    });

    const url =
      "http://localhost/api/approvals" +
      "?status=decided" +
      "&session=sess-1" +
      "&tool=read_file" +
      "&decision=approved" +
      "&from=2026-01-01T00:00:00.000Z" +
      "&to=2026-01-31T23:59:59.000Z" +
      "&limit=25";
    const res = await GET(makeRequest(url));
    expect(res.status).toBe(200);

    const fromCall = currentSupabase._spies.from.mock.results[0]?.value as
      | Record<string, ReturnType<typeof vi.fn>>
      | undefined;
    expect(fromCall).toBeDefined();
    const selectFn = fromCall!.select!;
    const chain = selectFn.mock.results[0]?.value as Record<string, ReturnType<typeof vi.fn>>;
    expect(chain.eq).toHaveBeenCalledWith("status", "decided");
    expect(chain.eq).toHaveBeenCalledWith("ekko_session_id", "sess-1");
    expect(chain.eq).toHaveBeenCalledWith("tool_name", "read_file");
    expect(chain.eq).toHaveBeenCalledWith("decision", "approved");
    expect(chain.gte).toHaveBeenCalledWith("requested_at", "2026-01-01T00:00:00.000Z");
    expect(chain.lte).toHaveBeenCalledWith("requested_at", "2026-01-31T23:59:59.000Z");
    expect(chain.limit).toHaveBeenCalledWith(25);
  });

  it("returns 500 when supabase reports an error", async () => {
    currentSupabase = mockSupabaseClient({
      approvals: { select: { data: null, error: { message: "boom" } } },
    });
    const res = await GET(makeRequest("http://localhost/api/approvals"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("boom");
  });

  it("defaults to status=pending when not supplied", async () => {
    currentSupabase = mockSupabaseClient({
      approvals: { select: { data: [], error: null } },
    });
    await GET(makeRequest("http://localhost/api/approvals"));
    const fromCall = currentSupabase._spies.from.mock.results[0]?.value as
      | Record<string, ReturnType<typeof vi.fn>>
      | undefined;
    const chain = fromCall!.select!.mock.results[0]?.value as Record<
      string,
      ReturnType<typeof vi.fn>
    >;
    expect(chain.eq).toHaveBeenCalledWith("status", "pending");
  });

  it("enriches approvals with client_name via pipeline -> client resolution", async () => {
    currentSupabase = mockSupabaseClient({
      approvals: {
        select: {
          data: [
            {
              id: "a1",
              status: "pending",
              tool_name: "mcp_pipeline_operator_pipeline_operator_render",
              tool_args: { pipeline_id: "p1", kind: "concept_preview", items: [1] },
              context: null,
            },
            {
              id: "a2",
              status: "pending",
              tool_name: "kie_generate",
              tool_args: { prompt: "x" },
              context: { pipeline_id: "p1" },
            },
            {
              id: "a3",
              status: "pending",
              tool_name: "shell_exec",
              tool_args: {},
              context: null,
            },
          ],
          error: null,
        },
      },
      pipelines: { select: { data: [{ id: "p1", client_id: "c1" }], error: null } },
      clients: { select: { data: [{ id: "c1", name: "Acme Co" }], error: null } },
    });

    const res = await GET(makeRequest("http://localhost/api/approvals"));
    expect(res.status).toBe(200);
    const body = await res.json();

    type Enriched = { id: string; client_name: string | null; pipeline_id: string | null };
    const rows = body.approvals as Enriched[];
    const byId = (id: string): Enriched => {
      const found = rows.find((a) => a.id === id);
      if (!found) throw new Error(`missing approval ${id}`);
      return found;
    };
    expect(byId("a1").client_name).toBe("Acme Co");
    expect(byId("a1").pipeline_id).toBe("p1");
    expect(byId("a2").client_name).toBe("Acme Co");
    expect(byId("a2").pipeline_id).toBe("p1");
    // No pipeline -> null client.
    expect(byId("a3").client_name).toBeNull();
    expect(byId("a3").pipeline_id).toBeNull();

    // Exactly three `from` calls: approvals, pipelines, clients (no N+1).
    const tables = currentSupabase._spies.from.mock.calls.map((c) => c[0]);
    expect(tables).toEqual(["approvals", "pipelines", "clients"]);
  });

  it("attaches client_name=null when no approval carries a pipeline id", async () => {
    currentSupabase = mockSupabaseClient({
      approvals: {
        select: {
          data: [{ id: "a1", status: "pending", tool_name: "shell_exec", tool_args: {}, context: null }],
          error: null,
        },
      },
    });

    const res = await GET(makeRequest("http://localhost/api/approvals"));
    const body = await res.json();
    expect(body.approvals[0].client_name).toBeNull();
    // Only the approvals query runs — no pipeline/client lookups.
    const tables = currentSupabase._spies.from.mock.calls.map((c) => c[0]);
    expect(tables).toEqual(["approvals"]);
  });
});
