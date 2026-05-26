/**
 * Tests for `app/api/creatives/[id]/qa/route.ts`.
 *
 * QA re-run is the APPEND-ONLY corrective action for `qa_result`: the worker
 * INSERTs a NEW attempt; prior attempts are never edited (migration 0041). The
 * route resolves the creative (image then video store), pulls its pipeline_id,
 * and proxies to the worker QA tool. The GUARDRAIL tests assert the route
 * refuses edit/delete verbs (there is no editing a prior attempt).
 */
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { mockClient } from "@/tests/unit/helpers/api-mock";
import { type SupabaseClientMock } from "@/tests/unit/helpers/supabase-mock";

let currentSupabase: SupabaseClientMock = mockClient();
const qaRunMock = vi.fn();

// Defined via vi.hoisted so the vi.mock factory (hoisted to the top) can
// reference the fake WorkerError class without a TDZ error.
const { FakeWorkerError } = vi.hoisted(() => {
  class FakeWorkerError extends Error {
    status?: number;
    constructor(message: string, status?: number) {
      super(message);
      this.name = "WorkerError";
      this.status = status;
    }
  }
  return { FakeWorkerError };
});

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => currentSupabase,
}));
vi.mock("@/lib/worker", () => ({
  qaRun: (...args: unknown[]) => qaRunMock(...args),
  WorkerError: FakeWorkerError,
}));

import { POST, PATCH, PUT, DELETE } from "./route";

const id = "11111111-1111-4111-8111-111111111111";
const pipelineId = "22222222-2222-4222-8222-222222222222";
const params = Promise.resolve({ id });

function req(body?: unknown, opts: { invalidJson?: boolean } = {}): NextRequest {
  return new NextRequest(
    new Request(`http://localhost/api/creatives/${id}/qa`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: opts.invalidJson ? "{not json" : body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

function imageCreativeClient(pid: string | null = pipelineId): SupabaseClientMock {
  return mockClient({
    creatives: { select: { single: { data: { id, pipeline_id: pid }, error: null } } },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  qaRunMock.mockReset();
});

describe("POST /api/creatives/:id/qa", () => {
  it("400 on a present-but-malformed JSON body", async () => {
    currentSupabase = imageCreativeClient();
    const res = await POST(req(undefined, { invalidJson: true }), { params });
    expect(res.status).toBe(400);
  });

  it("422 on a malformed body (bad surface)", async () => {
    currentSupabase = imageCreativeClient();
    const res = await POST(req({ surface: "audio" }), { params });
    expect(res.status).toBe(422);
  });

  it("404 when the creative exists in neither store", async () => {
    currentSupabase = mockClient({
      creatives: { select: { single: { data: null, error: null } } },
      video_creatives: { select: { single: { data: null, error: null } } },
    });
    const res = await POST(req({}), { params });
    expect(res.status).toBe(404);
  });

  it("500 when the image-store read errors", async () => {
    currentSupabase = mockClient({
      creatives: { select: { single: { data: null, error: { message: "img boom" } } } },
    });
    const res = await POST(req({}), { params });
    expect(res.status).toBe(500);
  });

  it("500 when the video-store fallback read errors", async () => {
    currentSupabase = mockClient({
      creatives: { select: { single: { data: null, error: null } } },
      video_creatives: { select: { single: { data: null, error: { message: "vid boom" } } } },
    });
    const res = await POST(req({}), { params });
    expect(res.status).toBe(500);
  });

  it("409 when the creative isn't linked to a pipeline", async () => {
    currentSupabase = imageCreativeClient(null);
    const res = await POST(req({}), { params });
    expect(res.status).toBe(409);
  });

  it("happy path: proxies to the worker QA tool and returns the result (empty body)", async () => {
    currentSupabase = imageCreativeClient();
    qaRunMock.mockResolvedValue({
      ok: true,
      pipeline_id: pipelineId,
      stage: "creative_qa",
      rollup: "passed",
      results: [
        { creative_id: id, surface: "image", verdict: "pass", status: "passed", attempt: 2 },
      ],
      errors: [],
    });
    const res = await POST(req(), { params });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rollup).toBe("passed");
    // The worker was called with the resolved pipeline + the creative item.
    expect(qaRunMock).toHaveBeenCalledWith({
      pipeline_id: pipelineId,
      items: [{ creative_id: id, surface: "image" }],
    });
  });

  it("defaults the surface to video when the creative lives in the video store", async () => {
    currentSupabase = mockClient({
      creatives: { select: { single: { data: null, error: null } } },
      video_creatives: {
        select: { single: { data: { id, pipeline_id: pipelineId }, error: null } },
      },
    });
    qaRunMock.mockResolvedValue({ ok: true, rollup: "passed", results: [], errors: [] });
    const res = await POST(req(), { params });
    expect(res.status).toBe(200);
    expect(qaRunMock).toHaveBeenCalledWith({
      pipeline_id: pipelineId,
      items: [{ creative_id: id, surface: "video" }],
    });
  });

  it("forwards an explicit surface + ratio override", async () => {
    currentSupabase = imageCreativeClient();
    qaRunMock.mockResolvedValue({ ok: true, rollup: "passed", results: [], errors: [] });
    await POST(req({ surface: "video", ratio: "9x16", vertical: "roofing" }), { params });
    expect(qaRunMock).toHaveBeenCalledWith({
      pipeline_id: pipelineId,
      items: [{ creative_id: id, surface: "video", vertical: "roofing", ratio: "9x16" }],
    });
  });

  it("502 when the worker errors (WorkerError)", async () => {
    currentSupabase = imageCreativeClient();
    qaRunMock.mockRejectedValue(new FakeWorkerError("worker 500", 500));
    const res = await POST(req({}), { params });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBe("worker_error");
    expect(body.status).toBe(500);
  });

  it("502 when the worker is unreachable (non-WorkerError)", async () => {
    currentSupabase = imageCreativeClient();
    qaRunMock.mockRejectedValue(new Error("ECONNREFUSED"));
    const res = await POST(req({}), { params });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBe("worker_unreachable");
  });
});

describe("GUARDRAIL: qa_result is append-only — edit/delete refused", () => {
  it("PATCH 405 (cannot edit a prior attempt)", () => {
    const res = PATCH();
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("POST");
  });

  it("PUT 405", () => {
    const res = PUT();
    expect(res.status).toBe(405);
  });

  it("DELETE 405 (cannot erase QA history)", () => {
    const res = DELETE();
    expect(res.status).toBe(405);
  });

  it("does NOT call the worker on a refused verb", () => {
    PATCH();
    DELETE();
    expect(qaRunMock).not.toHaveBeenCalled();
  });
});
