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

  it("enqueues the operator_dispatch work_item on approval (silent-failure PR-3)", async () => {
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
              // Operator-driven pipeline -> the operator renders finals.
              config_draft: { operator_driven: true },
            },
            error: null,
          },
        },
        update: { data: { id, status: "generation" }, error: null },
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
    // Silent-failure PR-3: the legacy fire-and-forget dispatchOperator is
    // gone -- the operator-daemon claims the queued work_item from the
    // canonical queue. We assert via the enqueue spy.
    expect(enqueueWorkItem).toHaveBeenCalledTimes(1);
    const opts = enqueueWorkItem.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(opts.kind).toBe("operator_dispatch");
    expect((opts.payload as Record<string, unknown>).stage).toBe("generation");
  });

  it("does NOT enqueue any work_item on rejection", async () => {
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
        update: { data: { id, status: "cancelled" }, error: null },
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
    expect(enqueueWorkItem).not.toHaveBeenCalled();
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
        // Silent-failure PR-3: the route awaits the chain directly; the
        // error rides the base-result on update.
        update: { data: null, error: { message: "no" } },
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
        update: { data: null, error: { message: "no" } },
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

  it("500 when reject pipeline_cancelled event insert fails (silent-failure PR-3: no longer swallowed)", async () => {
    currentSupabase = mockClient({
      pipelines: {
        select: {
          single: {
            data: { id, status: "review", format_choice: "image", picks: {}, advanced_at: {} },
            error: null,
          },
        },
        update: { data: { id, status: "cancelled" }, error: null },
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
    // The pipeline_cancelled event is the load-bearing input to the
    // reducer AND the cancel-propagate trigger; a failed insert no longer
    // console.warns and returns 200.
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(String(body.error)).toContain("ev down");
  });

  it("500 when approve stage_advanced event insert fails (silent-failure PR-3: no longer swallowed)", async () => {
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
        update: { data: { id }, error: null },
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
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(String(body.error)).toContain("ev down");
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
    // Regular (non-operator) pipeline: the work_item enqueue happens; the
    // legacy fire-and-forget operator dispatch is gone (silent-failure
    // PR-3) and the daemon-claimed queue is the only producer.
    await new Promise((r) => setTimeout(r, 5));
    expect(enqueueWorkItem).toHaveBeenCalledTimes(1);
    const opts = enqueueWorkItem.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(opts.kind).toBe("worker_generation");
  });

  // Silent-failure PR-3 cutover: the legacy "worker 404 is swallowed"
  // assertion is gone -- the route no longer fetch()es the worker. The
  // work_item enqueue is the only producer and the worker polls the queue.

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
      // The enqueue was the sole producer of the operator dispatch; nothing
      // else fired (silent-failure PR-3: legacy fire-and-forget is gone).
    });

    it("FIX-F: does NOT emit the stage_advanced event when the enqueue throws (enqueue-before-emit ordering)", async () => {
      // FINDING 1: the stage_advanced->generation event is the SOLE input that
      // flips the reducer. Emitting it BEFORE a failed enqueue left the
      // pipeline advanced to `generation` with no work_item (permanent silent
      // non-execution). With the enqueue-before-emit ordering a failed enqueue
      // 500s before the event is ever written, so the reducer stays at `review`
      // -- a consistent, recoverable state.
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
      // The stage_advanced event must never have been inserted: the route
      // touched `pipelines` (read + update) but never reached `pipeline_events`.
      const touchedTables = currentSupabase._spies.from.mock.calls.map((c) => c[0]);
      expect(touchedTables).not.toContain("pipeline_events");
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
