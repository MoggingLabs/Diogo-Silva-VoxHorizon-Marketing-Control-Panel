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
        update: { single: { data: null, error: { message: "no" } } },
      },
    });
    const res = await POST(req({ decision: "kill" }), { params });
    expect(res.status).toBe(500);
  });

  it("forwards the verdict to the worker when configured (200)", async () => {
    process.env.WORKER_URL = "http://worker.local";
    process.env.WORKER_SHARED_SECRET = "secret";
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    currentSupabase = inMonitorStage();
    const res = await POST(req({ decision: "kill" }), { params });
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 5));
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://worker.local/work/pipeline/monitor",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("warns when event insert + worker kick fail (still 200)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.WORKER_URL = "http://worker.local";
    process.env.WORKER_SHARED_SECRET = "secret";
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("x", { status: 500 }));
    currentSupabase = mockClient({
      pipelines: {
        select: { single: { data: { id, status: "monitor", advanced_at: {} }, error: null } },
        update: { single: { data: { id, status: "done" }, error: null } },
      },
      pipeline_events: { insert: { data: null, error: { message: "ev down" } } },
    });
    const res = await POST(req({ decision: "scale" }), { params });
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 5));
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
