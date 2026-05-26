/**
 * Tests for `app/api/pipelines/[id]/cancel/route.ts`.
 *
 * The route forwards to `kanbanCancel` from `@/lib/hermes/client` for
 * each pending/running task on the pipeline. `lib/hermes/client.ts`
 * pulls `server-only`, which we neutralise before importing the route.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { mockClient } from "@/tests/unit/helpers/api-mock";
import { type SupabaseClientMock } from "@/tests/unit/helpers/supabase-mock";

let currentSupabase: SupabaseClientMock = mockClient();
const kanbanCancelMock = vi.fn();

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => currentSupabase,
}));
vi.mock("@/lib/hermes/client", () => {
  class HermesError extends Error {
    status?: number;
    constructor(message: string, status?: number) {
      super(message);
      this.name = "HermesError";
      this.status = status;
    }
  }
  return {
    HermesError,
    kanbanCancel: (...args: unknown[]) => kanbanCancelMock(...args),
    chatStream: vi.fn(),
    chatAbort: vi.fn(),
    kanbanCreate: vi.fn(),
    kanbanGet: vi.fn(),
    kanbanRetry: vi.fn(),
    kanbanEvents: vi.fn(),
  };
});

import { POST } from "./route";

const id = "11111111-1111-4111-8111-111111111111";
const params = Promise.resolve({ id });

function req(url: string, init: RequestInit = {}): NextRequest {
  return new NextRequest(new Request(url, init));
}

describe("POST /api/pipelines/:id/cancel", () => {
  beforeEach(() => {
    currentSupabase = mockClient();
    kanbanCancelMock.mockReset();
  });

  it("cancels from configuration (200)", async () => {
    currentSupabase = mockClient({
      pipelines: {
        select: {
          single: { data: { id, status: "configuration", advanced_at: {} }, error: null },
        },
        update: { single: { data: { id, status: "cancelled" }, error: null } },
      },
      pipeline_events: { insert: { data: null, error: null } },
    });
    const res = await POST(req(`http://localhost/api/pipelines/${id}/cancel`, { method: "POST" }), {
      params,
    });
    expect(res.status).toBe(200);
  });

  it("cancels from generation with prior advanced_at (200)", async () => {
    currentSupabase = mockClient({
      pipelines: {
        select: {
          single: {
            data: { id, status: "generation", advanced_at: { ideation: "t1" } },
            error: null,
          },
        },
        update: { single: { data: { id, status: "cancelled" }, error: null } },
      },
      pipeline_events: { insert: { data: null, error: null } },
    });
    const res = await POST(req(`http://localhost/api/pipelines/${id}/cancel`, { method: "POST" }), {
      params,
    });
    expect(res.status).toBe(200);
  });

  it("coerces null advanced_at to empty object (200)", async () => {
    currentSupabase = mockClient({
      pipelines: {
        select: { single: { data: { id, status: "review", advanced_at: null }, error: null } },
        update: { single: { data: { id, status: "cancelled" }, error: null } },
      },
      pipeline_events: { insert: { data: null, error: null } },
    });
    const res = await POST(req(`http://localhost/api/pipelines/${id}/cancel`, { method: "POST" }), {
      params,
    });
    expect(res.status).toBe(200);
  });

  it("500 on read error", async () => {
    currentSupabase = mockClient({
      pipelines: { select: { single: { data: null, error: { message: "x" } } } },
    });
    const res = await POST(req(`http://localhost/api/pipelines/${id}/cancel`, { method: "POST" }), {
      params,
    });
    expect(res.status).toBe(500);
  });

  it("404 when missing", async () => {
    currentSupabase = mockClient({
      pipelines: { select: { single: { data: null, error: null } } },
    });
    const res = await POST(req(`http://localhost/api/pipelines/${id}/cancel`, { method: "POST" }), {
      params,
    });
    expect(res.status).toBe(404);
  });

  it("409 when already cancelled", async () => {
    currentSupabase = mockClient({
      pipelines: { select: { single: { data: { id, status: "cancelled" }, error: null } } },
    });
    const res = await POST(req(`http://localhost/api/pipelines/${id}/cancel`, { method: "POST" }), {
      params,
    });
    expect(res.status).toBe(409);
  });

  it("409 when done", async () => {
    currentSupabase = mockClient({
      pipelines: { select: { single: { data: { id, status: "done" }, error: null } } },
    });
    const res = await POST(req(`http://localhost/api/pipelines/${id}/cancel`, { method: "POST" }), {
      params,
    });
    expect(res.status).toBe(409);
  });

  it("500 when update fails", async () => {
    currentSupabase = mockClient({
      pipelines: {
        select: {
          single: { data: { id, status: "configuration", advanced_at: {} }, error: null },
        },
        // Silent-failure PR-3: the route awaits the chain directly (no
        // `.single()`), so the error rides the base-result on update.
        update: { data: null, error: { message: "race" } },
      },
    });
    const res = await POST(req(`http://localhost/api/pipelines/${id}/cancel`, { method: "POST" }), {
      params,
    });
    expect(res.status).toBe(500);
  });

  it("500 when the pipeline_cancelled event insert fails (silent-failure PR-3: no longer swallowed)", async () => {
    currentSupabase = mockClient({
      pipelines: {
        select: {
          single: { data: { id, status: "configuration", advanced_at: {} }, error: null },
        },
        update: { data: { id, status: "cancelled" }, error: null },
      },
      pipeline_events: { insert: { data: null, error: { message: "events down" } } },
    });
    const res = await POST(req(`http://localhost/api/pipelines/${id}/cancel`, { method: "POST" }), {
      params,
    });
    // Silent-failure PR-3 cutover: the pipeline_cancelled event is the
    // load-bearing input to the reducer AND the cancel-propagate trigger;
    // a failed insert no longer console.warns and returns 200 -- it
    // surfaces as 5xx so the operator can retry.
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(String(body.error)).toContain("events down");
  });

  // ----------------------------------------------------------------------
  // Kanban fan-out
  // ----------------------------------------------------------------------

  it("fans out kanban cancels for every active task (200)", async () => {
    currentSupabase = mockClient({
      pipelines: {
        select: {
          single: { data: { id, status: "generation", advanced_at: {} }, error: null },
        },
        update: { single: { data: { id, status: "cancelled" }, error: null } },
      },
      pipeline_events: { insert: { data: null, error: null } },
      hermes_tasks: {
        select: {
          data: [
            { kanban_task_id: "kt-1", status: "in_progress" },
            { kanban_task_id: "kt-2", status: "blocked" },
          ],
          error: null,
        },
      },
    });
    kanbanCancelMock.mockResolvedValue({ task_id: "x", action: "cancel", ok: true });
    const res = await POST(req(`http://localhost/api/pipelines/${id}/cancel`, { method: "POST" }), {
      params,
    });
    expect(res.status).toBe(200);
    expect(kanbanCancelMock).toHaveBeenCalledTimes(2);
    expect(kanbanCancelMock).toHaveBeenCalledWith("kt-1");
    expect(kanbanCancelMock).toHaveBeenCalledWith("kt-2");
  });

  it("warns + 200 when hermes_tasks lookup errors (no fan-out)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    currentSupabase = mockClient({
      pipelines: {
        select: {
          single: { data: { id, status: "generation", advanced_at: {} }, error: null },
        },
        update: { single: { data: { id, status: "cancelled" }, error: null } },
      },
      pipeline_events: { insert: { data: null, error: null } },
      hermes_tasks: { select: { data: null, error: { message: "tasks down" } } },
    });
    const res = await POST(req(`http://localhost/api/pipelines/${id}/cancel`, { method: "POST" }), {
      params,
    });
    expect(res.status).toBe(200);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("tasks down"));
    expect(kanbanCancelMock).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("warns + 200 when hermes_tasks lookup throws (no fan-out)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    currentSupabase = mockClient({
      pipelines: {
        select: {
          single: { data: { id, status: "generation", advanced_at: {} }, error: null },
        },
        update: { single: { data: { id, status: "cancelled" }, error: null } },
      },
      pipeline_events: { insert: { data: null, error: null } },
    });
    // Make the hermes_tasks chain throw at terminal resolution.
    const broken = currentSupabase as unknown as { from: (t: string) => unknown };
    const origFrom = broken.from;
    broken.from = vi.fn((table: string) => {
      if (table === "hermes_tasks") {
        const chain: Record<string, unknown> = {};
        const pass = vi.fn(() => chain);
        for (const m of ["select", "eq", "in"]) chain[m] = pass;
        chain.then = (onF: (v: unknown) => unknown, onR: (e: unknown) => unknown) =>
          Promise.reject(new Error("net down")).then(onF, onR);
        return chain;
      }
      return (origFrom as (t: string) => unknown)(table);
    }) as unknown as typeof origFrom;

    const res = await POST(req(`http://localhost/api/pipelines/${id}/cancel`, { method: "POST" }), {
      params,
    });
    expect(res.status).toBe(200);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("net down"));
    warn.mockRestore();
  });

  it("warns + still returns 200 when one kanban cancel fails with HermesError", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    currentSupabase = mockClient({
      pipelines: {
        select: {
          single: { data: { id, status: "generation", advanced_at: {} }, error: null },
        },
        update: { single: { data: { id, status: "cancelled" }, error: null } },
      },
      pipeline_events: { insert: { data: null, error: null } },
      hermes_tasks: {
        select: {
          data: [
            { kanban_task_id: "kt-1", status: "in_progress" },
            { kanban_task_id: "kt-2", status: "pending" },
          ],
          error: null,
        },
      },
    });
    const { HermesError } = (await import("@/lib/hermes/client")) as unknown as {
      HermesError: new (msg: string, status?: number) => Error;
    };
    kanbanCancelMock
      .mockRejectedValueOnce(new HermesError("upstream", 503))
      .mockResolvedValueOnce({ task_id: "kt-2", action: "cancel", ok: true });
    const res = await POST(req(`http://localhost/api/pipelines/${id}/cancel`, { method: "POST" }), {
      params,
    });
    expect(res.status).toBe(200);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("kt-1"));
    warn.mockRestore();
  });

  it("warns when a kanban cancel throws a non-HermesError (still 200)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    currentSupabase = mockClient({
      pipelines: {
        select: {
          single: { data: { id, status: "generation", advanced_at: {} }, error: null },
        },
        update: { single: { data: { id, status: "cancelled" }, error: null } },
      },
      pipeline_events: { insert: { data: null, error: null } },
      hermes_tasks: {
        select: {
          data: [{ kanban_task_id: "kt-1", status: "in_progress" }],
          error: null,
        },
      },
    });
    kanbanCancelMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const res = await POST(req(`http://localhost/api/pipelines/${id}/cancel`, { method: "POST" }), {
      params,
    });
    expect(res.status).toBe(200);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("ECONNREFUSED"));
    warn.mockRestore();
  });

  it("skips fan-out when no active tasks are present (200, no kanban call)", async () => {
    currentSupabase = mockClient({
      pipelines: {
        select: {
          single: { data: { id, status: "configuration", advanced_at: {} }, error: null },
        },
        update: { single: { data: { id, status: "cancelled" }, error: null } },
      },
      pipeline_events: { insert: { data: null, error: null } },
      hermes_tasks: { select: { data: [], error: null } },
    });
    const res = await POST(req(`http://localhost/api/pipelines/${id}/cancel`, { method: "POST" }), {
      params,
    });
    expect(res.status).toBe(200);
    expect(kanbanCancelMock).not.toHaveBeenCalled();
  });
});
