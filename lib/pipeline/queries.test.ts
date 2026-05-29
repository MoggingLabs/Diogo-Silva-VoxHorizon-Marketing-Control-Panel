/**
 * Tests for the server-only pipeline data layer (`lib/pipeline/queries.ts`).
 *
 * These functions hold the route bodies that the dashboard Server Components
 * now call DIRECTLY (instead of self-fetching the gated `/api/pipelines*`
 * routes). The route handlers are thin HTTP wrappers over the same functions,
 * so the external contract is exercised by the route tests; here we cover the
 * data-layer behaviour (filters, null-vs-throw, the non-fatal event insert).
 *
 * `@/lib/supabase/admin` is mocked so the functions run without a real
 * Supabase URL / key, driven by the shared `mockSupabaseClient` helper.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { mockSupabaseClient, type SupabaseClientMock } from "@/tests/unit/helpers/supabase-mock";

let currentSupabase: SupabaseClientMock = mockSupabaseClient();

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => currentSupabase,
}));

import { createPipelineRecord, getPipelineQuery, listPipelinesQuery } from "./queries";

describe("listPipelinesQuery", () => {
  beforeEach(() => {
    currentSupabase = mockSupabaseClient();
  });

  it("lists active rows and computes next_cursor when the page is full", async () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({
      id: `p${i}`,
      status: "configuration",
      format_choice: "image",
      created_at: `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
    }));
    currentSupabase = mockSupabaseClient({
      pipelines: { select: { data: rows, error: null } },
    });

    const res = await listPipelinesQuery({ limit: 10 });

    expect(res.pipelines).toHaveLength(10);
    expect(res.next_cursor).toBe(rows[9]!.created_at);
  });

  it("returns a null next_cursor when the page is under the limit", async () => {
    currentSupabase = mockSupabaseClient({
      pipelines: {
        select: {
          data: [{ id: "p1", status: "done", created_at: "2026-01-01T00:00:00Z" }],
          error: null,
        },
      },
    });

    const res = await listPipelinesQuery({ limit: 50 });
    expect(res.next_cursor).toBeNull();
  });

  it("short-circuits to an empty page when the status filter matches nothing", async () => {
    currentSupabase = mockSupabaseClient({
      v_pipeline_dispatch_state: { select: { data: [], error: null } },
    });

    const res = await listPipelinesQuery({ status: "ideation", limit: 50 });

    expect(res).toEqual({ pipelines: [], next_cursor: null });
    // The pipelines table is never queried once the status set is empty.
    const fromCalls = currentSupabase._spies.from.mock.calls.map((c) => c[0]);
    expect(fromCalls).toContain("v_pipeline_dispatch_state");
    expect(fromCalls).not.toContain("pipelines");
  });

  it("intersects the status set with the pipelines page + applies client_id/cursor/limit", async () => {
    currentSupabase = mockSupabaseClient({
      v_pipeline_dispatch_state: {
        select: { data: [{ pipeline_id: "p1", derived_status: "ideation" }], error: null },
      },
      pipelines: { select: { data: [], error: null } },
    });

    await listPipelinesQuery({
      status: "ideation",
      client_id: "22222222-2222-4222-8222-222222222222",
      cursor: "2026-01-01T00:00:00.000Z",
      limit: 10,
    });

    const fromCalls = currentSupabase._spies.from.mock.calls.map((c) => c[0]);
    expect(fromCalls).toContain("v_pipeline_dispatch_state");
    expect(fromCalls).toContain("pipelines");

    const viewIdx = fromCalls.indexOf("v_pipeline_dispatch_state");
    const viewResult = currentSupabase._spies.from.mock.results[viewIdx]?.value as
      | Record<string, ReturnType<typeof vi.fn>>
      | undefined;
    const viewChain = viewResult?.select?.mock.results[0]?.value as
      | Record<string, ReturnType<typeof vi.fn>>
      | undefined;
    expect(viewChain?.eq).toHaveBeenCalledWith("derived_status", "ideation");

    const pipelinesIdx = fromCalls.indexOf("pipelines");
    const pipelinesResult = currentSupabase._spies.from.mock.results[pipelinesIdx]?.value as
      | Record<string, ReturnType<typeof vi.fn>>
      | undefined;
    const selectChain = pipelinesResult?.select?.mock.results[0]?.value as
      | Record<string, ReturnType<typeof vi.fn>>
      | undefined;
    expect(selectChain?.in).toHaveBeenCalledWith("id", ["p1"]);
    expect(selectChain?.eq).toHaveBeenCalledWith(
      "client_id",
      "22222222-2222-4222-8222-222222222222",
    );
    expect(selectChain?.lt).toHaveBeenCalledWith("created_at", "2026-01-01T00:00:00.000Z");
    expect(selectChain?.limit).toHaveBeenCalledWith(10);
  });

  it("filters to archived rows (deleted_at is not null) when archived=true", async () => {
    currentSupabase = mockSupabaseClient({
      pipelines: { select: { data: [], error: null } },
    });

    await listPipelinesQuery({ limit: 50, archived: true });

    const fromResult = currentSupabase._spies.from.mock.results[0]?.value as
      | Record<string, ReturnType<typeof vi.fn>>
      | undefined;
    const selectChain = fromResult?.select?.mock.results[0]?.value as
      | Record<string, ReturnType<typeof vi.fn>>
      | undefined;
    expect(selectChain?.not).toHaveBeenCalledWith("deleted_at", "is", null);
    expect(selectChain?.is).not.toHaveBeenCalledWith("deleted_at", null);
  });

  it("throws when the dispatch-state view query errors", async () => {
    currentSupabase = mockSupabaseClient({
      v_pipeline_dispatch_state: { select: { data: null, error: { message: "view down" } } },
    });
    await expect(listPipelinesQuery({ status: "ideation", limit: 50 })).rejects.toThrow(
      "view down",
    );
  });

  it("throws when the pipelines query errors", async () => {
    currentSupabase = mockSupabaseClient({
      pipelines: { select: { data: null, error: { message: "connection refused" } } },
    });
    await expect(listPipelinesQuery({ limit: 50 })).rejects.toThrow("connection refused");
  });
});

describe("getPipelineQuery", () => {
  const id = "11111111-1111-4111-8111-111111111111";

  beforeEach(() => {
    currentSupabase = mockSupabaseClient();
  });

  it("returns the pipeline + embedded briefs/events when found", async () => {
    currentSupabase = mockSupabaseClient({
      pipelines: {
        select: {
          data: null,
          error: null,
          single: {
            data: {
              id,
              status: "configuration",
              image_brief: { id: "ib1" },
              video_brief: { id: "vb1" },
              events: [{ id: "e1" }],
            },
            error: null,
          },
        },
      },
    });

    const res = await getPipelineQuery(id);
    expect(res).not.toBeNull();
    expect(res!.pipeline.id).toBe(id);
    expect(res!.image_brief).toEqual({ id: "ib1" });
    expect(res!.video_brief).toEqual({ id: "vb1" });
    expect(res!.events).toEqual([{ id: "e1" }]);
  });

  it("defaults the embedded values to null/[] when absent", async () => {
    currentSupabase = mockSupabaseClient({
      pipelines: {
        select: {
          data: null,
          error: null,
          single: { data: { id, status: "configuration" }, error: null },
        },
      },
    });

    const res = await getPipelineQuery(id);
    expect(res!.image_brief).toBeNull();
    expect(res!.video_brief).toBeNull();
    expect(res!.events).toEqual([]);
  });

  it("returns null when the row is missing", async () => {
    currentSupabase = mockSupabaseClient({
      pipelines: { select: { data: null, error: null, single: { data: null, error: null } } },
    });
    const res = await getPipelineQuery(id);
    expect(res).toBeNull();
  });

  it("throws on a DB error", async () => {
    currentSupabase = mockSupabaseClient({
      pipelines: {
        select: { data: null, error: null, single: { data: null, error: { message: "x" } } },
      },
    });
    await expect(getPipelineQuery(id)).rejects.toThrow("x");
  });
});

describe("createPipelineRecord", () => {
  beforeEach(() => {
    currentSupabase = mockSupabaseClient();
  });

  it("inserts the pipeline + bootstrap event and returns the hydrated row", async () => {
    currentSupabase = mockSupabaseClient({
      pipelines: {
        insert: {
          data: null,
          error: null,
          single: {
            data: { id: "p1", status: "configuration", format_choice: "image", client_id: null },
            error: null,
          },
        },
      },
      pipeline_events: { insert: { data: null, error: null } },
    });

    const pipeline = await createPipelineRecord({ format_choice: "image" });
    expect(pipeline.id).toBe("p1");
    expect(currentSupabase._spies.from).toHaveBeenCalledWith("pipelines");
    expect(currentSupabase._spies.from).toHaveBeenCalledWith("pipeline_events");
  });

  it("forwards an optional client_id to the insert", async () => {
    const clientId = "11111111-1111-4111-8111-111111111111";
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
              client_id: clientId,
            },
            error: null,
          },
        },
      },
      pipeline_events: { insert: { data: null, error: null } },
    });

    const pipeline = await createPipelineRecord({ format_choice: "video", client_id: clientId });
    expect(pipeline.client_id).toBe(clientId);
  });

  it("still returns the row when the event insert fails (non-fatal)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    currentSupabase = mockSupabaseClient({
      pipelines: {
        insert: {
          data: null,
          error: null,
          single: {
            data: { id: "p3", status: "configuration", format_choice: "both", client_id: null },
            error: null,
          },
        },
      },
      pipeline_events: { insert: { data: null, error: { message: "events table offline" } } },
    });

    const pipeline = await createPipelineRecord({ format_choice: "both" });
    expect(pipeline.id).toBe("p3");
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("events table offline"));
    warnSpy.mockRestore();
  });

  it("throws when the pipelines insert fails", async () => {
    currentSupabase = mockSupabaseClient({
      pipelines: {
        insert: {
          data: null,
          error: null,
          single: { data: null, error: { message: "duplicate key" } },
        },
      },
    });
    await expect(createPipelineRecord({ format_choice: "image" })).rejects.toThrow("duplicate key");
  });
});
