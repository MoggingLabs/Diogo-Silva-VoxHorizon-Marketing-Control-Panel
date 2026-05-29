/**
 * Tests for `app/api/pipelines/[id]/variant-plan/decision/route.ts`.
 */
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mockClient } from "@/tests/unit/helpers/api-mock";
import { type SupabaseClientMock } from "@/tests/unit/helpers/supabase-mock";

let currentSupabase: SupabaseClientMock = mockClient();

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => currentSupabase,
}));

const { enqueueWorkItem } = vi.hoisted(() => ({
  enqueueWorkItem: vi.fn<(opts: unknown) => Promise<{ id: string; duplicate: boolean }>>(),
}));
vi.mock("@/lib/work-queue/enqueue", () => ({ enqueueWorkItem }));

import { POST } from "./route";

const id = "11111111-1111-4111-8111-111111111111";
const params = Promise.resolve({ id });

function req(body: unknown | string): NextRequest {
  return new NextRequest(
    new Request(`http://localhost/api/pipelines/${id}/variant-plan/decision`, {
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  currentSupabase = mockClient();
  enqueueWorkItem.mockReset();
  enqueueWorkItem.mockResolvedValue({ id: "wi-1", duplicate: false });
});
afterEach(() => vi.restoreAllMocks());

describe("POST /api/pipelines/:id/variant-plan/decision", () => {
  it("approves and advances to finalize_assets (200)", async () => {
    currentSupabase = mockClient({
      pipelines: {
        select: { single: { data: { id, status: "variant_plan", advanced_at: {} }, error: null } },
        update: { single: { data: { id, status: "finalize_assets" }, error: null } },
      },
      variant_plan: { update: { data: null, error: null } },
      pipeline_events: { insert: { data: null, error: null } },
    });
    const res = await POST(req({ decision: "approved" }), { params });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.pipeline.status).toBe("finalize_assets");
  });

  it("rejects (stays in variant_plan) with notes (200)", async () => {
    currentSupabase = mockClient({
      pipelines: { select: { single: { data: { id, status: "variant_plan" }, error: null } } },
      variant_plan: { update: { data: null, error: null } },
      pipeline_events: { insert: { data: null, error: null } },
    });
    const res = await POST(req({ decision: "rejected", notes: "too narrow" }), { params });
    expect(res.status).toBe(200);
  });

  it("400 reject without notes", async () => {
    const res = await POST(req({ decision: "rejected" }), { params });
    expect(res.status).toBe(400);
  });

  it("400 invalid JSON", async () => {
    const res = await POST(req("{"), { params });
    expect(res.status).toBe(400);
  });

  it("404 missing", async () => {
    currentSupabase = mockClient({
      pipelines: { select: { single: { data: null, error: null } } },
    });
    const res = await POST(req({ decision: "approved" }), { params });
    expect(res.status).toBe(404);
  });

  it("409 wrong stage", async () => {
    currentSupabase = mockClient({
      pipelines: { select: { single: { data: { id, status: "copy" }, error: null } } },
    });
    const res = await POST(req({ decision: "approved" }), { params });
    expect(res.status).toBe(409);
  });

  it("500 read error", async () => {
    currentSupabase = mockClient({
      pipelines: { select: { single: { data: null, error: { message: "db" } } } },
    });
    const res = await POST(req({ decision: "approved" }), { params });
    expect(res.status).toBe(500);
  });

  it("500 when advance update fails", async () => {
    currentSupabase = mockClient({
      pipelines: {
        select: { single: { data: { id, status: "variant_plan", advanced_at: {} }, error: null } },
        update: { single: { data: null, error: { message: "no" } } },
      },
      variant_plan: { update: { data: null, error: null } },
    });
    const res = await POST(req({ decision: "approved" }), { params });
    expect(res.status).toBe(500);
  });

  it("warns when the best-effort variant_plan row update fails but still succeeds (200)", async () => {
    // The variant_plan verdict row update is genuinely best-effort (the plan
    // row may not exist yet); only the stage_advanced event is load-bearing.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    currentSupabase = mockClient({
      pipelines: {
        select: {
          single: { data: { id, status: "variant_plan", advanced_at: null }, error: null },
        },
        update: { single: { data: { id, status: "finalize_assets" }, error: null } },
      },
      variant_plan: { update: { data: null, error: { message: "plan down" } } },
      pipeline_events: { insert: { data: null, error: null } },
    });
    const res = await POST(req({ decision: "approved" }), { params });
    expect(res.status).toBe(200);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("500 when the stage_advanced event insert fails (FIX-F: no longer swallowed)", async () => {
    // FINDING 2: the stage_advanced->finalize_assets event is the SOLE input
    // the reducer reads. A failed insert used to console.warn + return 200,
    // leaving the reducer a stage behind under a false "approved" UI. It is now
    // strict (500) -- matching the sibling advance/route.ts failure class.
    currentSupabase = mockClient({
      pipelines: {
        select: { single: { data: { id, status: "variant_plan", advanced_at: {} }, error: null } },
        update: { single: { data: { id, status: "finalize_assets" }, error: null } },
      },
      variant_plan: { update: { data: null, error: null } },
      pipeline_events: { insert: { data: null, error: { message: "ev down" } } },
    });
    const res = await POST(req({ decision: "approved" }), { params });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(String(body.error)).toContain("ev down");
    // The finalize dispatch must NOT have been enqueued -- we 500 before it.
    expect(enqueueWorkItem).not.toHaveBeenCalled();
  });

  // FIX-A: finalize_assets is inherently OPERATOR-HELD work in BOTH modes --
  // only the operator's Drive MCP can upload the finals + verify, so every
  // approved variant_plan hands off to the operator via
  // operator_dispatch(finalize_assets), deterministic pipelines included.
  it("deterministic approve ALSO enqueues operator_dispatch(finalize_assets) (operator hand-off)", async () => {
    currentSupabase = mockClient({
      pipelines: {
        select: { single: { data: { id, status: "variant_plan", advanced_at: {} }, error: null } },
        update: { single: { data: { id, status: "finalize_assets" }, error: null } },
      },
      variant_plan: { update: { data: null, error: null } },
      pipeline_events: { insert: { data: null, error: null } },
    });
    const res = await POST(req({ decision: "approved" }), { params });
    expect(res.status).toBe(200);
    expect(enqueueWorkItem).toHaveBeenCalledTimes(1);
    const opts = enqueueWorkItem.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(opts.kind).toBe("operator_dispatch");
    expect(opts.idempotencyKey).toBe(`op-disp:${id}:finalize_assets:variant_plan_approve`);
    const payload = opts.payload as Record<string, unknown>;
    expect(payload.stage).toBe("finalize_assets");
  });

  it("operator-driven approve enqueues operator_dispatch(finalize_assets)", async () => {
    currentSupabase = mockClient({
      pipelines: {
        select: {
          single: {
            data: {
              id,
              status: "variant_plan",
              advanced_at: {},
              config_draft: { operator_driven: true },
            },
            error: null,
          },
        },
        update: { single: { data: { id, status: "finalize_assets" }, error: null } },
      },
      variant_plan: { update: { data: null, error: null } },
      pipeline_events: { insert: { data: null, error: null } },
    });
    const res = await POST(req({ decision: "approved" }), { params });
    expect(res.status).toBe(200);
    expect(enqueueWorkItem).toHaveBeenCalledTimes(1);
    const opts = enqueueWorkItem.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(opts.kind).toBe("operator_dispatch");
    expect(opts.idempotencyKey).toBe(`op-disp:${id}:finalize_assets:variant_plan_approve`);
    const payload = opts.payload as Record<string, unknown>;
    expect(payload.stage).toBe("finalize_assets");
    expect(String(payload.instruction)).toContain(id);
  });

  it("operator-driven reject enqueues nothing (stays in variant_plan)", async () => {
    currentSupabase = mockClient({
      pipelines: {
        select: {
          single: {
            data: { id, status: "variant_plan", config_draft: { operator_driven: true } },
            error: null,
          },
        },
      },
      variant_plan: { update: { data: null, error: null } },
      pipeline_events: { insert: { data: null, error: null } },
    });
    const res = await POST(req({ decision: "rejected", notes: "re-plan" }), { params });
    expect(res.status).toBe(200);
    expect(enqueueWorkItem).not.toHaveBeenCalled();
  });

  it("500 when the operator finalize dispatch enqueue fails (not swallowed)", async () => {
    enqueueWorkItem.mockRejectedValueOnce(new Error("work_item insert failed: boom"));
    currentSupabase = mockClient({
      pipelines: {
        select: {
          single: {
            data: {
              id,
              status: "variant_plan",
              advanced_at: {},
              config_draft: { operator_driven: true },
            },
            error: null,
          },
        },
        update: { single: { data: { id, status: "finalize_assets" }, error: null } },
      },
      variant_plan: { update: { data: null, error: null } },
      pipeline_events: { insert: { data: null, error: null } },
    });
    const res = await POST(req({ decision: "approved" }), { params });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(String(body.error)).toContain("finalize dispatch enqueue failed");
  });
});
