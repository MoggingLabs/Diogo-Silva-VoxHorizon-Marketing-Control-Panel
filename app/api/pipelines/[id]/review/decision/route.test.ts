/**
 * Tests for `app/api/pipelines/[id]/review/decision/route.ts`.
 */
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mockClient } from "@/tests/unit/helpers/api-mock";
import { type SupabaseClientMock } from "@/tests/unit/helpers/supabase-mock";

let currentSupabase: SupabaseClientMock = mockClient();

// `@/lib/operator/dispatch` imports `server-only`; neutralise it so the jsdom
// route-test project can load the (partially mocked) module.
vi.mock("server-only", () => ({}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => currentSupabase,
}));

// `vi.hoisted` so the spy exists when the hoisted `vi.mock` factory runs.
const { dispatchOperator } = vi.hoisted(() => ({
  dispatchOperator: vi.fn<(id: string, instruction: string) => Promise<void>>(async () => {}),
}));
vi.mock("@/lib/operator/dispatch", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/operator/dispatch")>("@/lib/operator/dispatch");
  return { ...actual, dispatchOperator };
});

const { enqueueWorkItem } = vi.hoisted(() => ({
  enqueueWorkItem: vi.fn<(opts: unknown) => Promise<{ id: string; duplicate: boolean }>>(
    async () => ({ id: "wi-1", duplicate: false }),
  ),
}));
vi.mock("@/lib/work-queue/enqueue", () => ({ enqueueWorkItem }));

import { POST } from "./route";

const id = "11111111-1111-4111-8111-111111111111";
const params = Promise.resolve({ id });

function req(url: string, init: RequestInit = {}): NextRequest {
  return new NextRequest(new Request(url, init));
}

beforeEach(() => {
  currentSupabase = mockClient();
  dispatchOperator.mockClear();
  enqueueWorkItem.mockReset();
  enqueueWorkItem.mockResolvedValue({ id: "wi-1", duplicate: false });
  delete process.env.WORKER_URL;
  delete process.env.WORKER_SHARED_SECRET;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /api/pipelines/:id/review/decision", () => {
  it("approves a review-stage pipeline (200)", async () => {
    currentSupabase = mockClient({
      pipelines: {
        select: {
          single: {
            data: {
              id,
              status: "review",
              format_choice: "image",
              picks: { image: ["c1"] },
              advanced_at: {},
            },
            error: null,
          },
        },
        update: { single: { data: { id, status: "generation" }, error: null } },
      },
      pipeline_events: { insert: { data: null, error: null } },
    });
    const res = await POST(
      req(`http://localhost/api/pipelines/${id}/review/decision`, {
        method: "POST",
        body: JSON.stringify({ decision: "approved" }),
      }),
      { params },
    );
    expect(res.status).toBe(200);
  });

  it("re-tasks the operator to render finals on approval", async () => {
    currentSupabase = mockClient({
      pipelines: {
        select: {
          single: {
            data: {
              id,
              status: "review",
              format_choice: "image",
              picks: { image: ["c1"] },
              advanced_at: {},
              // Operator-driven pipeline → the operator renders finals (the
              // deterministic /work/pipeline/generation producer is skipped).
              config_draft: { operator_driven: true },
            },
            error: null,
          },
        },
        update: { single: { data: { id, status: "generation" }, error: null } },
      },
      pipeline_events: { insert: { data: null, error: null } },
    });
    const res = await POST(
      req(`http://localhost/api/pipelines/${id}/review/decision`, {
        method: "POST",
        body: JSON.stringify({ decision: "approved" }),
      }),
      { params },
    );
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 5));
    expect(dispatchOperator).toHaveBeenCalledTimes(1);
    const [pid, instruction] = dispatchOperator.mock.calls[0]!;
    expect(pid).toBe(id);
    expect(instruction.toLowerCase()).toContain("final");
  });

  it("does NOT re-task the operator on rejection", async () => {
    currentSupabase = mockClient({
      pipelines: {
        select: {
          single: {
            data: {
              id,
              status: "review",
              format_choice: "image",
              picks: { image: ["c1"] },
              advanced_at: {},
            },
            error: null,
          },
        },
        update: { single: { data: { id, status: "cancelled" }, error: null } },
      },
      pipeline_events: { insert: { data: null, error: null } },
    });
    const res = await POST(
      req(`http://localhost/api/pipelines/${id}/review/decision`, {
        method: "POST",
        body: JSON.stringify({ decision: "rejected", notes: "no" }),
      }),
      { params },
    );
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 5));
    expect(dispatchOperator).not.toHaveBeenCalled();
  });

  it("approved_with_changes (200)", async () => {
    currentSupabase = mockClient({
      pipelines: {
        select: {
          single: {
            data: {
              id,
              status: "review",
              format_choice: "video",
              picks: { video: ["v1"] },
              advanced_at: { ideation: "t" },
            },
            error: null,
          },
        },
        update: { single: { data: { id, status: "generation" }, error: null } },
      },
      pipeline_events: { insert: { data: null, error: null } },
    });
    const res = await POST(
      req(`http://localhost/api/pipelines/${id}/review/decision`, {
        method: "POST",
        body: JSON.stringify({ decision: "approved_with_changes", notes: "tighten copy" }),
      }),
      { params },
    );
    expect(res.status).toBe(200);
  });

  it("rejects (cancels) the pipeline (200)", async () => {
    currentSupabase = mockClient({
      pipelines: {
        select: {
          single: {
            data: {
              id,
              status: "review",
              format_choice: "image",
              picks: { image: ["c1"] },
              advanced_at: {},
            },
            error: null,
          },
        },
        update: { single: { data: { id, status: "cancelled" }, error: null } },
      },
      pipeline_events: { insert: { data: null, error: null } },
    });
    const res = await POST(
      req(`http://localhost/api/pipelines/${id}/review/decision`, {
        method: "POST",
        body: JSON.stringify({ decision: "rejected", notes: "no" }),
      }),
      { params },
    );
    expect(res.status).toBe(200);
  });

  it("400 invalid JSON", async () => {
    const res = await POST(
      req(`http://localhost/api/pipelines/${id}/review/decision`, { method: "POST", body: "{" }),
      { params },
    );
    expect(res.status).toBe(400);
  });

  it("400 zod fail (rejected missing notes)", async () => {
    const res = await POST(
      req(`http://localhost/api/pipelines/${id}/review/decision`, {
        method: "POST",
        body: JSON.stringify({ decision: "rejected" }),
      }),
      { params },
    );
    expect(res.status).toBe(400);
  });

  it("500 read error", async () => {
    currentSupabase = mockClient({
      pipelines: { select: { single: { data: null, error: { message: "x" } } } },
    });
    const res = await POST(
      req(`http://localhost/api/pipelines/${id}/review/decision`, {
        method: "POST",
        body: JSON.stringify({ decision: "approved" }),
      }),
      { params },
    );
    expect(res.status).toBe(500);
  });

  it("404 missing", async () => {
    currentSupabase = mockClient({
      pipelines: { select: { single: { data: null, error: null } } },
    });
    const res = await POST(
      req(`http://localhost/api/pipelines/${id}/review/decision`, {
        method: "POST",
        body: JSON.stringify({ decision: "approved" }),
      }),
      { params },
    );
    expect(res.status).toBe(404);
  });

  it("409 wrong state", async () => {
    currentSupabase = mockClient({
      pipelines: { select: { single: { data: { id, status: "configuration" }, error: null } } },
    });
    const res = await POST(
      req(`http://localhost/api/pipelines/${id}/review/decision`, {
        method: "POST",
        body: JSON.stringify({ decision: "approved" }),
      }),
      { params },
    );
    expect(res.status).toBe(409);
  });

  it("500 when reject update fails", async () => {
    currentSupabase = mockClient({
      pipelines: {
        select: {
          single: {
            data: { id, status: "review", format_choice: "image", picks: {}, advanced_at: {} },
            error: null,
          },
        },
        update: { single: { data: null, error: { message: "no" } } },
      },
    });
    const res = await POST(
      req(`http://localhost/api/pipelines/${id}/review/decision`, {
        method: "POST",
        body: JSON.stringify({ decision: "rejected", notes: "n" }),
      }),
      { params },
    );
    expect(res.status).toBe(500);
  });

  it("500 when approve update fails", async () => {
    currentSupabase = mockClient({
      pipelines: {
        select: {
          single: {
            data: {
              id,
              status: "review",
              format_choice: "image",
              picks: { image: ["c1"] },
              advanced_at: {},
            },
            error: null,
          },
        },
        update: { single: { data: null, error: { message: "no" } } },
      },
    });
    const res = await POST(
      req(`http://localhost/api/pipelines/${id}/review/decision`, {
        method: "POST",
        body: JSON.stringify({ decision: "approved" }),
      }),
      { params },
    );
    expect(res.status).toBe(500);
  });

  it("warns when reject event insert fails (still 200)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    currentSupabase = mockClient({
      pipelines: {
        select: {
          single: {
            data: { id, status: "review", format_choice: "image", picks: {}, advanced_at: {} },
            error: null,
          },
        },
        update: { single: { data: { id, status: "cancelled" }, error: null } },
      },
      pipeline_events: { insert: { data: null, error: { message: "ev down" } } },
    });
    const res = await POST(
      req(`http://localhost/api/pipelines/${id}/review/decision`, {
        method: "POST",
        body: JSON.stringify({ decision: "rejected", notes: "n" }),
      }),
      { params },
    );
    expect(res.status).toBe(200);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("warns when approve event insert fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    currentSupabase = mockClient({
      pipelines: {
        select: {
          single: {
            data: {
              id,
              status: "review",
              format_choice: "image",
              picks: { image: ["c1"] },
              advanced_at: {},
            },
            error: null,
          },
        },
        update: { single: { data: { id }, error: null } },
      },
      pipeline_events: { insert: { data: null, error: { message: "ev down" } } },
    });
    const res = await POST(
      req(`http://localhost/api/pipelines/${id}/review/decision`, {
        method: "POST",
        body: JSON.stringify({ decision: "approved" }),
      }),
      { params },
    );
    expect(res.status).toBe(200);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("kicks worker successfully (200)", async () => {
    process.env.WORKER_URL = "http://worker.local";
    process.env.WORKER_SHARED_SECRET = "secret";
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(null, { status: 200 }));
    currentSupabase = mockClient({
      pipelines: {
        select: {
          single: {
            data: {
              id,
              status: "review",
              format_choice: "image",
              picks: { image: ["c1"] },
              advanced_at: {},
            },
            error: null,
          },
        },
        update: { single: { data: { id }, error: null } },
      },
      pipeline_events: { insert: { data: null, error: null } },
    });
    const res = await POST(
      req(`http://localhost/api/pipelines/${id}/review/decision`, {
        method: "POST",
        body: JSON.stringify({ decision: "approved" }),
      }),
      { params },
    );
    expect(res.status).toBe(200);
    // Regular (non-operator) pipeline: the deterministic generation producer
    // runs and the operator is NOT dispatched (no double render).
    await new Promise((r) => setTimeout(r, 5));
    expect(dispatchOperator).not.toHaveBeenCalled();
  });

  it("warns when worker kick fails (still 200)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.WORKER_URL = "http://worker.local";
    process.env.WORKER_SHARED_SECRET = "secret";
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("oops", { status: 500 }));
    currentSupabase = mockClient({
      pipelines: {
        select: {
          single: {
            data: {
              id,
              status: "review",
              format_choice: "image",
              picks: { image: ["c1"] },
              advanced_at: {},
            },
            error: null,
          },
        },
        update: { single: { data: { id }, error: null } },
      },
      pipeline_events: { insert: { data: null, error: null } },
    });
    const res = await POST(
      req(`http://localhost/api/pipelines/${id}/review/decision`, {
        method: "POST",
        body: JSON.stringify({ decision: "approved" }),
      }),
      { params },
    );
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 5));
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("does not throw on worker 404", async () => {
    process.env.WORKER_URL = "http://worker.local";
    process.env.WORKER_SHARED_SECRET = "secret";
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(null, { status: 404 }));
    currentSupabase = mockClient({
      pipelines: {
        select: {
          single: {
            data: {
              id,
              status: "review",
              format_choice: "image",
              picks: { image: ["c1"] },
              advanced_at: {},
            },
            error: null,
          },
        },
        update: { single: { data: { id }, error: null } },
      },
      pipeline_events: { insert: { data: null, error: null } },
    });
    const res = await POST(
      req(`http://localhost/api/pipelines/${id}/review/decision`, {
        method: "POST",
        body: JSON.stringify({ decision: "approved" }),
      }),
      { params },
    );
    expect(res.status).toBe(200);
  });

  it("treats malformed picks (array) as zero counts", async () => {
    currentSupabase = mockClient({
      pipelines: {
        select: {
          single: {
            data: { id, status: "review", format_choice: "image", picks: null, advanced_at: null },
            error: null,
          },
        },
        update: { single: { data: { id }, error: null } },
      },
      pipeline_events: { insert: { data: null, error: null } },
    });
    const res = await POST(
      req(`http://localhost/api/pipelines/${id}/review/decision`, {
        method: "POST",
        body: JSON.stringify({ decision: "approved" }),
      }),
      { params },
    );
    expect(res.status).toBe(200);
  });

  // -- silent-failure foundational redesign PR-2b: dual-write to work_item --

  describe("dual-write enqueue (operator-driven approval -> generation)", () => {
    function operatorReviewPipeline() {
      return {
        id,
        status: "review",
        format_choice: "image",
        picks: { image: ["c1"] },
        advanced_at: {},
        config_draft: { operator_driven: true },
      };
    }

    it("enqueues an operator_dispatch work_item on approval (200)", async () => {
      currentSupabase = mockClient({
        pipelines: {
          select: { single: { data: operatorReviewPipeline(), error: null } },
          update: { single: { data: { id, status: "generation" }, error: null } },
        },
        pipeline_events: { insert: { data: null, error: null } },
      });
      const res = await POST(
        req(`http://localhost/api/pipelines/${id}/review/decision`, {
          method: "POST",
          body: JSON.stringify({ decision: "approved" }),
        }),
        { params },
      );
      expect(res.status).toBe(200);
      expect(enqueueWorkItem).toHaveBeenCalledTimes(1);
      const opts = enqueueWorkItem.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(opts.kind).toBe("operator_dispatch");
      expect(opts.pipelineId).toBe(id);
      expect(opts.idempotencyKey).toBe(`op-disp:${id}:generation:review_approved`);
      expect(opts.createdBy).toBe("api/pipelines/review/decision");
      const payload = opts.payload as Record<string, unknown>;
      expect(payload.stage).toBe("generation");
    });

    it("returns 500 when the work_item enqueue throws", async () => {
      enqueueWorkItem.mockRejectedValueOnce(new Error("work_item insert failed: boom"));
      currentSupabase = mockClient({
        pipelines: {
          select: { single: { data: operatorReviewPipeline(), error: null } },
          update: { single: { data: { id, status: "generation" }, error: null } },
        },
        pipeline_events: { insert: { data: null, error: null } },
      });
      const res = await POST(
        req(`http://localhost/api/pipelines/${id}/review/decision`, {
          method: "POST",
          body: JSON.stringify({ decision: "approved" }),
        }),
        { params },
      );
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(String(body.error)).toContain("work_item enqueue failed");
      // Legacy dispatch must NOT fire when the enqueue failed.
      await new Promise((r) => setTimeout(r, 5));
      expect(dispatchOperator).not.toHaveBeenCalled();
    });

    it("treats a duplicate idempotency_key as 200 (the dedup branch)", async () => {
      enqueueWorkItem.mockResolvedValueOnce({ id: "wi-existing", duplicate: true });
      currentSupabase = mockClient({
        pipelines: {
          select: { single: { data: operatorReviewPipeline(), error: null } },
          update: { single: { data: { id, status: "generation" }, error: null } },
        },
        pipeline_events: { insert: { data: null, error: null } },
      });
      const res = await POST(
        req(`http://localhost/api/pipelines/${id}/review/decision`, {
          method: "POST",
          body: JSON.stringify({ decision: "approved" }),
        }),
        { params },
      );
      expect(res.status).toBe(200);
    });
  });

  describe("dual-write enqueue (regular approval -> worker_generation)", () => {
    function regularReviewPipeline() {
      return {
        id,
        status: "review",
        format_choice: "image",
        picks: { image: ["c1"] },
        advanced_at: {},
      };
    }

    it("enqueues a worker_generation work_item on approval (200)", async () => {
      currentSupabase = mockClient({
        pipelines: {
          select: { single: { data: regularReviewPipeline(), error: null } },
          update: { single: { data: { id, status: "generation" }, error: null } },
        },
        pipeline_events: { insert: { data: null, error: null } },
      });
      const res = await POST(
        req(`http://localhost/api/pipelines/${id}/review/decision`, {
          method: "POST",
          body: JSON.stringify({ decision: "approved" }),
        }),
        { params },
      );
      expect(res.status).toBe(200);
      expect(enqueueWorkItem).toHaveBeenCalledTimes(1);
      const opts = enqueueWorkItem.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(opts.kind).toBe("worker_generation");
      expect(opts.pipelineId).toBe(id);
      expect(opts.idempotencyKey).toBe(`wg:${id}:generation`);
      expect(opts.createdBy).toBe("api/pipelines/review/decision");
    });

    it("returns 500 when the work_item enqueue throws", async () => {
      enqueueWorkItem.mockRejectedValueOnce(new Error("work_item insert failed: boom"));
      currentSupabase = mockClient({
        pipelines: {
          select: { single: { data: regularReviewPipeline(), error: null } },
          update: { single: { data: { id, status: "generation" }, error: null } },
        },
        pipeline_events: { insert: { data: null, error: null } },
      });
      const res = await POST(
        req(`http://localhost/api/pipelines/${id}/review/decision`, {
          method: "POST",
          body: JSON.stringify({ decision: "approved" }),
        }),
        { params },
      );
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(String(body.error)).toContain("work_item enqueue failed");
    });

    it("does NOT enqueue when the decision is rejected", async () => {
      currentSupabase = mockClient({
        pipelines: {
          select: { single: { data: regularReviewPipeline(), error: null } },
          update: { single: { data: { id, status: "cancelled" }, error: null } },
        },
        pipeline_events: { insert: { data: null, error: null } },
      });
      const res = await POST(
        req(`http://localhost/api/pipelines/${id}/review/decision`, {
          method: "POST",
          body: JSON.stringify({ decision: "rejected", notes: "no" }),
        }),
        { params },
      );
      expect(res.status).toBe(200);
      expect(enqueueWorkItem).not.toHaveBeenCalled();
    });

    it("treats a duplicate idempotency_key as 200 (the dedup branch)", async () => {
      enqueueWorkItem.mockResolvedValueOnce({ id: "wi-existing", duplicate: true });
      currentSupabase = mockClient({
        pipelines: {
          select: { single: { data: regularReviewPipeline(), error: null } },
          update: { single: { data: { id, status: "generation" }, error: null } },
        },
        pipeline_events: { insert: { data: null, error: null } },
      });
      const res = await POST(
        req(`http://localhost/api/pipelines/${id}/review/decision`, {
          method: "POST",
          body: JSON.stringify({ decision: "approved" }),
        }),
        { params },
      );
      expect(res.status).toBe(200);
    });
  });
});
