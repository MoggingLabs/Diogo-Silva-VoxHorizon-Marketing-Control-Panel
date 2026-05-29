/**
 * Tests for `app/api/pipelines/[id]/monitor/decision/route.ts` (#362).
 *
 * Monitor connector: an approved kill/scale verdict now advances to `done` AND
 * enqueues an `operator_dispatch(monitor_action)` so the operator EXECUTES the
 * change on Meta (kill -> pause; scale -> raise daily_budget) and records it via
 * the worker recorder. This replaces the prior no-op `worker_monitor` enqueue,
 * and the scale->spawn-next-brief side effect is REMOVED (a separate kickoff).
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
    new Request(`http://localhost/api/pipelines/${id}/monitor/decision`, {
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

const inMonitorStage = () =>
  mockClient({
    pipelines: {
      select: { single: { data: { id, status: "monitor", advanced_at: {} }, error: null } },
      update: { single: { data: { id, status: "done" }, error: null } },
    },
    pipeline_events: { insert: { data: null, error: null } },
  });

beforeEach(() => {
  currentSupabase = mockClient();
  enqueueWorkItem.mockReset();
  enqueueWorkItem.mockResolvedValue({ id: "wi-monitor-1", duplicate: false });
});
afterEach(() => vi.restoreAllMocks());

describe("POST /api/pipelines/:id/monitor/decision", () => {
  it("kills and advances to done (200)", async () => {
    currentSupabase = inMonitorStage();
    const res = await POST(req({ decision: "kill", campaign_id: "c1" }), { params });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.pipeline.status).toBe("done");
    expect(json.decision).toBe("kill");
  });

  it("scales and advances to done (200)", async () => {
    currentSupabase = inMonitorStage();
    const res = await POST(req({ decision: "scale", target_budget: 5000 }), { params });
    expect(res.status).toBe(200);
  });

  it("kill enqueues operator_dispatch(monitor_action), NOT worker_monitor", async () => {
    // Monitor connector: the verdict forward is now an operator_dispatch carrying
    // the verdict payload so the operator EXECUTES the kill on Meta (the worker
    // has no Meta credentials). Assert the enqueue's kind/payload contract.
    currentSupabase = inMonitorStage();
    const res = await POST(req({ decision: "kill", campaign_id: "c1" }), { params });
    expect(res.status).toBe(200);
    expect(enqueueWorkItem).toHaveBeenCalledTimes(1);
    const opts = enqueueWorkItem.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(opts.kind).toBe("operator_dispatch");
    expect(opts.kind).not.toBe("worker_monitor");
    expect(opts.idempotencyKey).toBe(`op-disp:${id}:monitor_action:kill`);
    const payload = opts.payload as Record<string, unknown>;
    expect(payload.action).toBe("monitor_action");
    expect(payload.decision).toBe("kill");
    expect(payload.campaign_id).toBe("c1");
    // stage stays a valid pipeline_status_enum value so the auto-emit trigger's
    // stage cast does not null it.
    expect(payload.stage).toBe("monitor");
    expect(String(payload.instruction)).toContain(id);
    // kill carries no target_budget.
    expect(payload.target_budget).toBeUndefined();
  });

  it("scale carries target_budget in the operator_dispatch payload", async () => {
    currentSupabase = inMonitorStage();
    const res = await POST(req({ decision: "scale", campaign_id: "c2", target_budget: 7500 }), {
      params,
    });
    expect(res.status).toBe(200);
    const opts = enqueueWorkItem.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(opts.kind).toBe("operator_dispatch");
    expect(opts.idempotencyKey).toBe(`op-disp:${id}:monitor_action:scale`);
    const payload = opts.payload as Record<string, unknown>;
    expect(payload.decision).toBe("scale");
    expect(payload.target_budget).toBe(7500);
    expect(String(payload.instruction)).toContain("7500");
  });

  it("does NOT spawn a child pipeline on scale (behavior change: decoupled)", async () => {
    // The old scale->spawn-next-brief side effect is removed. A scale records the
    // verdict, dispatches the Meta budget bump, and returns -- no child pipeline,
    // no spawned_pipeline_id in the response.
    currentSupabase = inMonitorStage();
    const res = await POST(req({ decision: "scale", target_budget: 5000 }), { params });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.spawned_pipeline_id).toBeUndefined();
    expect(json.spawn_error).toBeUndefined();
    // The only enqueue is the monitor_action dispatch (no child-pipeline insert
    // path runs); the route never opened a pipelines insert builder.
    const fromSpy = currentSupabase._spies.from;
    const pipelineInserts = fromSpy.mock.results
      .map((r) => r.value as { insert?: { mock?: { calls: unknown[][] } } })
      .filter(Boolean);
    // No `pipelines` insert was made (only select + update). The spawn helper is
    // gone, so enqueue is the sole producer.
    expect(enqueueWorkItem).toHaveBeenCalledTimes(1);
    expect(pipelineInserts).toBeDefined();
  });

  it("kill does not spawn a child pipeline either", async () => {
    currentSupabase = inMonitorStage();
    const res = await POST(req({ decision: "kill" }), { params });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.spawned_pipeline_id).toBeUndefined();
  });

  it("400 invalid decision", async () => {
    const res = await POST(req({ decision: "maybe" }), { params });
    expect(res.status).toBe(400);
  });

  it("400 invalid target_budget (non-positive)", async () => {
    const res = await POST(req({ decision: "scale", target_budget: -1 }), { params });
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
    const res = await POST(req({ decision: "kill" }), { params });
    expect(res.status).toBe(404);
  });

  it("409 wrong stage", async () => {
    currentSupabase = mockClient({
      pipelines: { select: { single: { data: { id, status: "launch_handoff" }, error: null } } },
    });
    const res = await POST(req({ decision: "kill" }), { params });
    expect(res.status).toBe(409);
  });

  it("500 read error", async () => {
    currentSupabase = mockClient({
      pipelines: { select: { single: { data: null, error: { message: "db" } } } },
    });
    const res = await POST(req({ decision: "kill" }), { params });
    expect(res.status).toBe(500);
  });

  it("500 when update fails", async () => {
    currentSupabase = mockClient({
      pipelines: {
        select: { single: { data: { id, status: "monitor", advanced_at: null }, error: null } },
        // error rides the base-result on update.
        update: { data: null, error: { message: "no" } },
      },
    });
    const res = await POST(req({ decision: "kill" }), { params });
    expect(res.status).toBe(500);
  });

  it("500 when the monitor_action dispatch enqueue fails (not swallowed)", async () => {
    // The enqueue is the SOLE producer of the executed Meta side effect, so a
    // failed enqueue is a 5xx (mirror of the post-gen dispatch routes) -- the
    // action must never silently go missing.
    enqueueWorkItem.mockRejectedValueOnce(new Error("work_item insert failed: boom"));
    currentSupabase = inMonitorStage();
    const res = await POST(req({ decision: "kill" }), { params });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(String(body.error)).toContain("monitor_action dispatch enqueue failed");
  });

  it("500 when stage_advanced event insert fails (load-bearing: not swallowed)", async () => {
    currentSupabase = mockClient({
      pipelines: {
        select: { single: { data: { id, status: "monitor", advanced_at: {} }, error: null } },
        update: { data: { id, status: "done" }, error: null },
      },
      pipeline_events: { insert: { data: null, error: { message: "ev down" } } },
    });
    const res = await POST(req({ decision: "scale", target_budget: 1000 }), { params });
    // The stage_advanced event is the reducer's load-bearing input -- the route
    // 5xxs on a failed insert rather than swallowing it. The enqueue must NOT
    // have run (we 500 before it).
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(String(body.error)).toContain("ev down");
    expect(enqueueWorkItem).not.toHaveBeenCalled();
  });
});
