/**
 * Tests for `app/api/pipelines/[id]/redispatch/route.ts` -- the silent-failure
 * foundational redesign's recovery surface. The route enqueues a fresh
 * operator_dispatch work_item chained (via parent_work_item_id) to the latest
 * failed / timed-out row for the pipeline.
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
    async () => ({ id: "wi-redispatched", duplicate: false }),
  ),
}));
vi.mock("@/lib/work-queue/enqueue", () => ({ enqueueWorkItem }));

import { POST } from "./route";

const id = "11111111-1111-4111-8111-111111111111";
const params = Promise.resolve({ id });

function req(): NextRequest {
  return new NextRequest(
    new Request(`http://localhost/api/pipelines/${id}/redispatch`, { method: "POST" }),
  );
}

beforeEach(() => {
  currentSupabase = mockClient();
  enqueueWorkItem.mockReset();
  enqueueWorkItem.mockResolvedValue({ id: "wi-redispatched", duplicate: false });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /api/pipelines/:id/redispatch", () => {
  function operatorDrivenPipeline(status = "configuration") {
    return {
      id,
      status,
      config_draft: { operator_driven: true },
    };
  }

  it("happy path: enqueues a retry chained to the failed row (200)", async () => {
    currentSupabase = mockClient({
      pipelines: {
        select: { single: { data: operatorDrivenPipeline("configuration"), error: null } },
      },
      work_item: {
        select: {
          single: {
            data: {
              id: "wi-failed-1",
              payload: { instruction: "draft brief X", stage: "configuration" },
            },
            error: null,
          },
        },
      },
    });
    const res = await POST(req(), { params });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.work_item_id).toBe("wi-redispatched");
    expect(body.duplicate).toBe(false);

    expect(enqueueWorkItem).toHaveBeenCalledTimes(1);
    const opts = enqueueWorkItem.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(opts.kind).toBe("operator_dispatch");
    expect(opts.pipelineId).toBe(id);
    expect(opts.parentWorkItemId).toBe("wi-failed-1");
    expect(opts.idempotencyKey).toBe(`op-disp:${id}:configuration:redispatch:wi-failed-1`);
    expect(opts.createdBy).toBe("api/pipelines/redispatch");
    const payload = opts.payload as Record<string, unknown>;
    expect(payload.instruction).toBe("draft brief X");
    expect(payload.stage).toBe("configuration");
  });

  it("falls back to a rebuilt instruction when the failed payload is missing", async () => {
    currentSupabase = mockClient({
      pipelines: {
        select: { single: { data: operatorDrivenPipeline("generation"), error: null } },
      },
      work_item: {
        select: {
          single: { data: { id: "wi-failed-bare", payload: null }, error: null },
        },
      },
    });
    const res = await POST(req(), { params });
    expect(res.status).toBe(200);
    const opts = enqueueWorkItem.mock.calls[0]?.[0] as Record<string, unknown>;
    const payload = opts.payload as Record<string, unknown>;
    // Stage fell back to the pipeline's current status.
    expect(payload.stage).toBe("generation");
    // Instruction was rebuilt from `operatorInstruction(stage, pipelineId)`.
    expect(String(payload.instruction)).toContain(id);
  });

  it("falls back to pipeline.status when the failed payload has no stage", async () => {
    currentSupabase = mockClient({
      pipelines: {
        select: { single: { data: operatorDrivenPipeline("configuration"), error: null } },
      },
      work_item: {
        select: {
          single: {
            data: {
              id: "wi-failed-no-stage",
              // Object payload but missing the stage key + missing the instruction
              payload: { other: "value" },
            },
            error: null,
          },
        },
      },
    });
    const res = await POST(req(), { params });
    expect(res.status).toBe(200);
    const opts = enqueueWorkItem.mock.calls[0]?.[0] as Record<string, unknown>;
    const payload = opts.payload as Record<string, unknown>;
    expect(payload.stage).toBe("configuration");
  });

  it("returns 404 when the pipeline does not exist", async () => {
    currentSupabase = mockClient({
      pipelines: { select: { single: { data: null, error: null } } },
    });
    const res = await POST(req(), { params });
    expect(res.status).toBe(404);
    expect(enqueueWorkItem).not.toHaveBeenCalled();
  });

  it("returns 500 when the pipeline read errors", async () => {
    currentSupabase = mockClient({
      pipelines: { select: { single: { data: null, error: { message: "db down" } } } },
    });
    const res = await POST(req(), { params });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("db down");
  });

  it("returns 409 invalid_state when the pipeline is cancelled", async () => {
    currentSupabase = mockClient({
      pipelines: {
        select: {
          single: {
            data: { id, status: "cancelled", config_draft: { operator_driven: true } },
            error: null,
          },
        },
      },
    });
    const res = await POST(req(), { params });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("invalid_state");
    expect(body.from).toBe("cancelled");
    expect(enqueueWorkItem).not.toHaveBeenCalled();
  });

  it("returns 409 invalid_state when the pipeline is done", async () => {
    currentSupabase = mockClient({
      pipelines: {
        select: {
          single: {
            data: { id, status: "done", config_draft: { operator_driven: true } },
            error: null,
          },
        },
      },
    });
    const res = await POST(req(), { params });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("invalid_state");
    expect(body.from).toBe("done");
  });

  it("returns 409 not_operator_driven for a regular pipeline", async () => {
    currentSupabase = mockClient({
      pipelines: {
        select: {
          single: {
            data: { id, status: "configuration", config_draft: { other: true } },
            error: null,
          },
        },
      },
    });
    const res = await POST(req(), { params });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("not_operator_driven");
    expect(enqueueWorkItem).not.toHaveBeenCalled();
  });

  it("returns 409 not_operator_driven when config_draft is null", async () => {
    currentSupabase = mockClient({
      pipelines: {
        select: {
          single: { data: { id, status: "configuration", config_draft: null }, error: null },
        },
      },
    });
    const res = await POST(req(), { params });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("not_operator_driven");
  });

  it("returns 409 no_failed_dispatch when no failed work_item exists", async () => {
    currentSupabase = mockClient({
      pipelines: {
        select: { single: { data: operatorDrivenPipeline("configuration"), error: null } },
      },
      work_item: {
        select: { single: { data: null, error: null } },
      },
    });
    const res = await POST(req(), { params });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("no_failed_dispatch");
    expect(enqueueWorkItem).not.toHaveBeenCalled();
  });

  it("returns 500 when the work_item lookup errors", async () => {
    currentSupabase = mockClient({
      pipelines: {
        select: { single: { data: operatorDrivenPipeline("configuration"), error: null } },
      },
      work_item: {
        select: { single: { data: null, error: { message: "wi read failed" } } },
      },
    });
    const res = await POST(req(), { params });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("wi read failed");
  });

  it("returns 502 when the enqueue throws (worker fault)", async () => {
    enqueueWorkItem.mockRejectedValueOnce(new Error("work_item insert failed: db down"));
    currentSupabase = mockClient({
      pipelines: {
        select: { single: { data: operatorDrivenPipeline("configuration"), error: null } },
      },
      work_item: {
        select: {
          single: {
            data: {
              id: "wi-failed-2",
              payload: { instruction: "draft", stage: "configuration" },
            },
            error: null,
          },
        },
      },
    });
    const res = await POST(req(), { params });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(String(body.error)).toContain("work_item enqueue failed");
  });

  it("returns 200 with duplicate:true when the redispatch was already queued", async () => {
    enqueueWorkItem.mockResolvedValueOnce({ id: "wi-existing-redispatch", duplicate: true });
    currentSupabase = mockClient({
      pipelines: {
        select: { single: { data: operatorDrivenPipeline("configuration"), error: null } },
      },
      work_item: {
        select: {
          single: {
            data: {
              id: "wi-failed-3",
              payload: { instruction: "x", stage: "configuration" },
            },
            error: null,
          },
        },
      },
    });
    const res = await POST(req(), { params });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.work_item_id).toBe("wi-existing-redispatch");
    expect(body.duplicate).toBe(true);
  });

  it("treats an operator_instruction-only config_draft as operator-driven", async () => {
    // Older operator pipelines carry just `operator_instruction` (no explicit
    // `operator_driven: true` flag); `isOperatorDriven` accepts that as the
    // marker, so the redispatch path must too.
    currentSupabase = mockClient({
      pipelines: {
        select: {
          single: {
            data: {
              id,
              status: "configuration",
              config_draft: { operator_instruction: "ads for client X" },
            },
            error: null,
          },
        },
      },
      work_item: {
        select: {
          single: {
            data: { id: "wi-failed-legacy", payload: { stage: "configuration" } },
            error: null,
          },
        },
      },
    });
    const res = await POST(req(), { params });
    expect(res.status).toBe(200);
  });
});
