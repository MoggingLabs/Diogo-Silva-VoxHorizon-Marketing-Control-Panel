/**
 * Tests for `app/api/pipelines/[id]/tasks/[task_event_id]/retry/route.ts`.
 *
 * After the HI-7 rewrite this route is a thin wrapper:
 *   - validate the source event (kind=task_error, stage=generation),
 *   - resolve the kanban_task_id (payload-inline or hermes_tasks fallback),
 *   - emit a `task_queued` row,
 *   - POST `/work/hermes/kanban/{id}/retry` via `@/lib/hermes/client`.
 *
 * We mock `@/lib/hermes/client` so the spec doesn't pull `server-only`
 * (which errors under jsdom) and so we can drive every retry / error
 * branch deterministically.
 */
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { mockClient } from "@/tests/unit/helpers/api-mock";
import { type SupabaseClientMock } from "@/tests/unit/helpers/supabase-mock";

let currentSupabase: SupabaseClientMock = mockClient();
const kanbanRetryMock = vi.fn();

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
    kanbanRetry: (...args: unknown[]) => kanbanRetryMock(...args),
    // Stub the rest so accidental imports don't blow up.
    chatStream: vi.fn(),
    chatAbort: vi.fn(),
    kanbanCreate: vi.fn(),
    kanbanGet: vi.fn(),
    kanbanCancel: vi.fn(),
    kanbanEvents: vi.fn(),
  };
});

import { POST } from "./route";

const pipelineId = "11111111-1111-4111-8111-111111111111";
const taskId = "22222222-2222-4222-8222-222222222222";
const params = Promise.resolve({ id: pipelineId, task_event_id: taskId });

function req(url: string, init: RequestInit = {}): NextRequest {
  return new NextRequest(new Request(url, init));
}

beforeEach(() => {
  currentSupabase = mockClient();
  kanbanRetryMock.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Validation guards
// ---------------------------------------------------------------------------

describe("POST /api/pipelines/:id/tasks/:task_event_id/retry — guards", () => {
  it("500 on read error", async () => {
    currentSupabase = mockClient({
      pipeline_events: { select: { single: { data: null, error: { message: "x" } } } },
    });
    const res = await POST(
      req("http://localhost/api/pipelines/p/tasks/t/retry", { method: "POST" }),
      { params },
    );
    expect(res.status).toBe(500);
  });

  it("404 missing task event", async () => {
    currentSupabase = mockClient({
      pipeline_events: { select: { single: { data: null, error: null } } },
    });
    const res = await POST(
      req("http://localhost/api/pipelines/p/tasks/t/retry", { method: "POST" }),
      { params },
    );
    expect(res.status).toBe(404);
  });

  it("422 when source kind isn't task_error", async () => {
    currentSupabase = mockClient({
      pipeline_events: {
        select: {
          single: { data: { id: taskId, kind: "task_running", stage: "generation" }, error: null },
        },
      },
    });
    const res = await POST(
      req("http://localhost/api/pipelines/p/tasks/t/retry", { method: "POST" }),
      { params },
    );
    expect(res.status).toBe(422);
  });

  it("422 when source stage isn't generation", async () => {
    currentSupabase = mockClient({
      pipeline_events: {
        select: {
          single: { data: { id: taskId, kind: "task_error", stage: "ideation" }, error: null },
        },
      },
    });
    const res = await POST(
      req("http://localhost/api/pipelines/p/tasks/t/retry", { method: "POST" }),
      { params },
    );
    expect(res.status).toBe(422);
  });

  it("422 when kanban_task_id cannot be resolved (no payload, no mirror row)", async () => {
    currentSupabase = mockClient({
      pipeline_events: {
        select: {
          single: {
            data: {
              id: taskId,
              kind: "task_error",
              stage: "generation",
              payload: {},
            },
            error: null,
          },
        },
      },
      // The fallback table lookup returns nothing.
      hermes_tasks: { select: { single: { data: null, error: null } } },
    });
    const res = await POST(
      req("http://localhost/api/pipelines/p/tasks/t/retry", { method: "POST" }),
      { params },
    );
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe("validation_failed");
  });

  it("warns + 422 when hermes_tasks fallback errors", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    currentSupabase = mockClient({
      pipeline_events: {
        select: {
          single: {
            data: {
              id: taskId,
              kind: "task_error",
              stage: "generation",
              payload: {},
            },
            error: null,
          },
        },
      },
      hermes_tasks: { select: { single: { data: null, error: { message: "boom" } } } },
    });
    const res = await POST(
      req("http://localhost/api/pipelines/p/tasks/t/retry", { method: "POST" }),
      { params },
    );
    expect(res.status).toBe(422);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("boom"));
    warn.mockRestore();
  });

  it("500 when queued insert fails", async () => {
    currentSupabase = mockClient({
      pipeline_events: {
        select: {
          single: {
            data: {
              id: taskId,
              kind: "task_error",
              stage: "generation",
              payload: { task_id: "kt-1" },
            },
            error: null,
          },
        },
        insert: { single: { data: null, error: { message: "ev" } } },
      },
    });
    const res = await POST(
      req("http://localhost/api/pipelines/p/tasks/t/retry", { method: "POST" }),
      { params },
    );
    expect(res.status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// kanban_task_id resolution paths
// ---------------------------------------------------------------------------

describe("POST retry — kanban_task_id resolution", () => {
  it("uses payload.task_id when present (202)", async () => {
    currentSupabase = mockClient({
      pipeline_events: {
        select: {
          single: {
            data: {
              id: taskId,
              kind: "task_error",
              stage: "generation",
              payload: { task_id: "kt-1" },
            },
            error: null,
          },
        },
        insert: { single: { data: { id: "queued1" }, error: null } },
      },
    });
    kanbanRetryMock.mockResolvedValueOnce({ task_id: "kt-1", action: "retry", ok: true });
    const res = await POST(
      req("http://localhost/api/pipelines/p/tasks/t/retry", { method: "POST" }),
      { params },
    );
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.retry_task_id).toBe("queued1");
    expect(body.kanban_task_id).toBe("kt-1");
    expect(kanbanRetryMock).toHaveBeenCalledWith("kt-1");
  });

  it("uses payload.kanban_task_id when task_id absent", async () => {
    currentSupabase = mockClient({
      pipeline_events: {
        select: {
          single: {
            data: {
              id: taskId,
              kind: "task_error",
              stage: "generation",
              payload: { kanban_task_id: "kt-2" },
            },
            error: null,
          },
        },
        insert: { single: { data: { id: "queued1" }, error: null } },
      },
    });
    kanbanRetryMock.mockResolvedValueOnce({ task_id: "kt-2", action: "retry", ok: true });
    const res = await POST(
      req("http://localhost/api/pipelines/p/tasks/t/retry", { method: "POST" }),
      { params },
    );
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.kanban_task_id).toBe("kt-2");
    expect(kanbanRetryMock).toHaveBeenCalledWith("kt-2");
  });

  it("falls back to hermes_tasks lookup when payload has no id", async () => {
    currentSupabase = mockClient({
      pipeline_events: {
        select: {
          single: {
            data: {
              id: taskId,
              kind: "task_error",
              stage: "generation",
              payload: {},
            },
            error: null,
          },
        },
        insert: { single: { data: { id: "queued1" }, error: null } },
      },
      hermes_tasks: {
        select: { single: { data: { kanban_task_id: "kt-fallback" }, error: null } },
      },
    });
    kanbanRetryMock.mockResolvedValueOnce({ task_id: "kt-fallback", action: "retry", ok: true });
    const res = await POST(
      req("http://localhost/api/pipelines/p/tasks/t/retry", { method: "POST" }),
      { params },
    );
    expect(res.status).toBe(202);
    expect(kanbanRetryMock).toHaveBeenCalledWith("kt-fallback");
  });

  it("warns + 422 when fallback lookup throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    currentSupabase = mockClient({
      pipeline_events: {
        select: {
          single: {
            data: {
              id: taskId,
              kind: "task_error",
              stage: "generation",
              payload: {},
            },
            error: null,
          },
        },
      },
    });
    // Make the hermes_tasks chain throw at the terminal `maybeSingle()` call.
    const broken = currentSupabase as unknown as {
      from: (table: string) => unknown;
    };
    const origFrom = broken.from;
    broken.from = vi.fn((table: string) => {
      if (table === "hermes_tasks") {
        const chain: Record<string, unknown> = {};
        const pass = vi.fn(() => chain);
        for (const m of ["select", "eq", "in", "order", "limit"]) chain[m] = pass;
        chain.maybeSingle = vi.fn(() => Promise.reject(new Error("net down")));
        return chain;
      }
      return (origFrom as (t: string) => unknown)(table);
    }) as unknown as typeof origFrom;
    const res = await POST(
      req("http://localhost/api/pipelines/p/tasks/t/retry", { method: "POST" }),
      { params },
    );
    expect(res.status).toBe(422);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("net down"));
    warn.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// kanbanRetry happy & error paths
// ---------------------------------------------------------------------------

describe("POST retry — worker dispatch", () => {
  beforeEach(() => {
    currentSupabase = mockClient({
      pipeline_events: {
        select: {
          single: {
            data: {
              id: taskId,
              kind: "task_error",
              stage: "generation",
              payload: { task_id: "kt-1" },
            },
            error: null,
          },
        },
        insert: { single: { data: { id: "queued1" }, error: null } },
      },
    });
  });

  it("202 on happy path", async () => {
    kanbanRetryMock.mockResolvedValueOnce({ task_id: "kt-1", action: "retry", ok: true });
    const res = await POST(
      req("http://localhost/api/pipelines/p/tasks/t/retry", { method: "POST" }),
      { params },
    );
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.source_task_id).toBe(taskId);
  });

  it("502 + HermesError shape when bridge fails with a known status", async () => {
    const { HermesError } = (await import("@/lib/hermes/client")) as unknown as {
      HermesError: new (msg: string, status?: number) => Error;
    };
    kanbanRetryMock.mockRejectedValueOnce(new HermesError("upstream sad", 503));
    const res = await POST(
      req("http://localhost/api/pipelines/p/tasks/t/retry", { method: "POST" }),
      { params },
    );
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBe("worker_error");
    expect(body.status).toBe(503);
    expect(body.retry_task_id).toBe("queued1");
    expect(body.kanban_task_id).toBe("kt-1");
  });

  it("502 + worker_unreachable when bridge throws a non-HermesError", async () => {
    kanbanRetryMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const res = await POST(
      req("http://localhost/api/pipelines/p/tasks/t/retry", { method: "POST" }),
      { params },
    );
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBe("worker_unreachable");
    expect(body.retry_task_id).toBe("queued1");
  });
});
