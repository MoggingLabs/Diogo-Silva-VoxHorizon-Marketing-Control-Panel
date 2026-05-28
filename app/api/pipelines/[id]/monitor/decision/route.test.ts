/**
 * Tests for `app/api/pipelines/[id]/monitor/decision/route.ts` (#362).
 */
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mockClient } from "@/tests/unit/helpers/api-mock";
import { type SupabaseClientMock } from "@/tests/unit/helpers/supabase-mock";

let currentSupabase: SupabaseClientMock = mockClient();

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => currentSupabase,
}));

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
    // Silent-failure PR-8: the route now enqueues a `worker_monitor` work_item
    // (instead of fire-and-forgetting at the non-existent /work/pipeline/monitor
    // endpoint). The enqueue probes then inserts; give it a clean path so the
    // best-effort forward succeeds without a logged warning.
    work_item: {
      select: { single: { data: null, error: null } },
      insert: { single: { data: { id: "wi-monitor-1" }, error: null } },
    },
  });

beforeEach(() => {
  currentSupabase = mockClient();
  delete process.env.WORKER_URL;
  delete process.env.WORKER_SHARED_SECRET;
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
    const res = await POST(req({ decision: "scale" }), { params });
    expect(res.status).toBe(200);
  });

  // --- monitor → next-brief loop (#368) ---

  const scaleParent = (overrides: Record<string, unknown> = {}) => ({
    id,
    status: "monitor",
    advanced_at: {},
    format_choice: "image",
    client_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    image_brief_id: null,
    ...overrides,
  });

  it("scale spawns a next-brief pipeline (200 + spawned_pipeline_id)", async () => {
    const childId = "22222222-2222-4222-8222-222222222222";
    currentSupabase = mockClient({
      pipelines: {
        select: { single: { data: scaleParent(), error: null } },
        update: { single: { data: { id, status: "done" }, error: null } },
        insert: { single: { data: { id: childId }, error: null } },
      },
      pipeline_events: { insert: { data: null, error: null } },
    });
    const res = await POST(req({ decision: "scale" }), { params });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.spawned_pipeline_id).toBe(childId);
    expect(json.spawn_error).toBeUndefined();
  });

  it("scale seeds the child from the parent's winning image brief", async () => {
    const childId = "33333333-3333-4333-8333-333333333333";
    currentSupabase = mockClient({
      pipelines: {
        select: { single: { data: scaleParent({ image_brief_id: "brief-1" }), error: null } },
        update: { single: { data: { id, status: "done" }, error: null } },
        insert: { single: { data: { id: childId }, error: null } },
      },
      briefs: {
        select: {
          single: {
            data: { payload: { service: "remodeling", budget: 5000, market: "Austin, TX" } },
            error: null,
          },
        },
      },
      pipeline_events: { insert: { data: null, error: null } },
    });
    const res = await POST(req({ decision: "scale" }), { params });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.spawned_pipeline_id).toBe(childId);
  });

  it("reports spawn_error when the child insert fails (still 200)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    currentSupabase = mockClient({
      pipelines: {
        select: { single: { data: scaleParent(), error: null } },
        update: { single: { data: { id, status: "done" }, error: null } },
        insert: { single: { data: null, error: { message: "insert boom" } } },
      },
      pipeline_events: { insert: { data: null, error: null } },
    });
    const res = await POST(req({ decision: "scale" }), { params });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.spawn_error).toContain("insert boom");
    expect(json.spawned_pipeline_id).toBeUndefined();
    warn.mockRestore();
  });

  it("500 when lineage / stage_advanced events fail to insert (silent-failure PR-3: no longer swallowed)", async () => {
    const childId = "44444444-4444-4444-8444-444444444444";
    currentSupabase = mockClient({
      pipelines: {
        select: { single: { data: scaleParent(), error: null } },
        update: { data: { id, status: "done" }, error: null },
        insert: { single: { data: { id: childId }, error: null } },
      },
      pipeline_events: { insert: { data: null, error: { message: "ev down" } } },
    });
    const res = await POST(req({ decision: "scale" }), { params });
    // Silent-failure PR-3: the stage_advanced event is load-bearing for
    // the reducer; a failed insert is now surfaced as 5xx.
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(String(body.error)).toContain("ev down");
  });

  it("kill does not spawn a next-brief pipeline", async () => {
    currentSupabase = inMonitorStage();
    const res = await POST(req({ decision: "kill" }), { params });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.spawned_pipeline_id).toBeUndefined();
    expect(json.spawn_error).toBeUndefined();
  });

  it("400 invalid decision", async () => {
    const res = await POST(req({ decision: "maybe" }), { params });
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
        // Silent-failure PR-3: error rides the base-result on update.
        update: { data: null, error: { message: "no" } },
      },
    });
    const res = await POST(req({ decision: "kill" }), { params });
    expect(res.status).toBe(500);
  });

  it("enqueues a worker_monitor work_item to forward the verdict (200)", async () => {
    // Silent-failure PR-8: the verdict forward is now a `worker_monitor`
    // work_item enqueue (the old fire-and-forget hit /work/pipeline/monitor,
    // which does not exist -- the 404 was swallowed). Assert the route inserts
    // a `worker_monitor` row so the verdict is tracked + visible; the
    // worker-stage consumer acknowledges it (the real Meta pause / budget write
    // is a one-function drop-in there).
    currentSupabase = inMonitorStage();
    const res = await POST(req({ decision: "kill", campaign_id: "c1" }), { params });
    expect(res.status).toBe(200);
    // The route opened a `from('work_item')` builder for the enqueue probe +
    // insert. Find the builder(s) for that table and assert an insert carrying
    // the worker_monitor kind + the pipeline id landed.
    const fromSpy = currentSupabase._spies.from;
    const workItemCalls = fromSpy.mock.calls.filter((c) => c[0] === "work_item");
    expect(workItemCalls.length).toBeGreaterThanOrEqual(1);
    const insertPayloads = fromSpy.mock.results
      .map((r) => r.value as { insert?: { mock?: { calls: unknown[][] } } })
      .flatMap((builder) => builder?.insert?.mock?.calls ?? [])
      .map((callArgs) => callArgs[0] as Record<string, unknown>);
    expect(insertPayloads).toContainEqual(
      expect.objectContaining({ kind: "worker_monitor", pipeline_id: id }),
    );
  });

  it("still returns 200 when the worker_monitor enqueue fails (best-effort)", async () => {
    // The run already reached `done`; a worker-queue outage must not undo it.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    currentSupabase = mockClient({
      pipelines: {
        select: { single: { data: { id, status: "monitor", advanced_at: {} }, error: null } },
        update: { single: { data: { id, status: "done" }, error: null } },
      },
      pipeline_events: { insert: { data: null, error: null } },
      work_item: {
        select: { single: { data: null, error: null } },
        insert: { single: { data: null, error: { message: "queue down" } } },
      },
    });
    const res = await POST(req({ decision: "kill" }), { params });
    expect(res.status).toBe(200);
    warn.mockRestore();
  });

  it("500 when stage_advanced event insert fails (silent-failure PR-3: no longer swallowed)", async () => {
    currentSupabase = mockClient({
      pipelines: {
        select: { single: { data: { id, status: "monitor", advanced_at: {} }, error: null } },
        update: { data: { id, status: "done" }, error: null },
      },
      pipeline_events: { insert: { data: null, error: { message: "ev down" } } },
    });
    const res = await POST(req({ decision: "scale" }), { params });
    // Silent-failure PR-3: the stage_advanced event is the reducer's
    // load-bearing input -- the route 5xxs on a failed insert rather
    // than console.warn-swallowing it.
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(String(body.error)).toContain("ev down");
  });
});
