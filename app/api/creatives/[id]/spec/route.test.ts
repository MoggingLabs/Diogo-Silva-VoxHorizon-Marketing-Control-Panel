/**
 * Tests for `app/api/creatives/[id]/spec/route.ts`.
 *
 * `spec_check` is OVERRIDE-ROUTE only: mutable via the worker upsert + the DB
 * rollup, never a raw UPDATE from the browser. The override carries a REQUIRED
 * reason. The GUARDRAIL tests assert a raw status PATCH/PUT/DELETE is refused
 * (the corrected status must flow through the worker route).
 */
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { mockClient } from "@/tests/unit/helpers/api-mock";
import { type SupabaseClientMock } from "@/tests/unit/helpers/supabase-mock";

let currentSupabase: SupabaseClientMock = mockClient();
const specRunMock = vi.fn();

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
  specRun: (...args: unknown[]) => specRunMock(...args),
  WorkerError: FakeWorkerError,
}));

import { POST, PATCH, PUT, DELETE } from "./route";

const id = "11111111-1111-4111-8111-111111111111";
const pipelineId = "22222222-2222-4222-8222-222222222222";
const params = Promise.resolve({ id });

const VALID = {
  platform: "meta",
  placement: "feed",
  status: "pass",
  reason: "Manager reviewed: the safe-zone overlay is within tolerance.",
};

function req(body: unknown, opts: { invalidJson?: boolean } = {}): NextRequest {
  return new NextRequest(
    new Request(`http://localhost/api/creatives/${id}/spec`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: opts.invalidJson ? "{not json" : JSON.stringify(body),
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
  specRunMock.mockReset();
});

describe("POST /api/creatives/:id/spec", () => {
  it("400 on malformed JSON", async () => {
    currentSupabase = imageCreativeClient();
    const res = await POST(req(null, { invalidJson: true }), { params });
    expect(res.status).toBe(400);
  });

  it("422 when reason is missing (no override without a justification)", async () => {
    currentSupabase = imageCreativeClient();
    const res = await POST(req({ platform: "meta", placement: "feed", status: "pass" }), {
      params,
    });
    expect(res.status).toBe(422);
  });

  it("422 when reason is empty/whitespace", async () => {
    currentSupabase = imageCreativeClient();
    const res = await POST(req({ ...VALID, reason: "   " }), { params });
    expect(res.status).toBe(422);
  });

  it("422 when placement is missing", async () => {
    currentSupabase = imageCreativeClient();
    const res = await POST(req({ status: "pass", reason: "ok reason" }), { params });
    expect(res.status).toBe(422);
  });

  it("422 when status is not a known spec status", async () => {
    currentSupabase = imageCreativeClient();
    const res = await POST(req({ ...VALID, status: "amazing" }), { params });
    expect(res.status).toBe(422);
  });

  it("404 when the creative exists in neither store", async () => {
    currentSupabase = mockClient({
      creatives: { select: { single: { data: null, error: null } } },
      video_creatives: { select: { single: { data: null, error: null } } },
    });
    const res = await POST(req(VALID), { params });
    expect(res.status).toBe(404);
  });

  it("500 when the image-store read errors", async () => {
    currentSupabase = mockClient({
      creatives: { select: { single: { data: null, error: { message: "img boom" } } } },
    });
    const res = await POST(req(VALID), { params });
    expect(res.status).toBe(500);
  });

  it("500 when the video-store fallback read errors", async () => {
    currentSupabase = mockClient({
      creatives: { select: { single: { data: null, error: null } } },
      video_creatives: { select: { single: { data: null, error: { message: "vid boom" } } } },
    });
    const res = await POST(req(VALID), { params });
    expect(res.status).toBe(500);
  });

  it("409 when the creative isn't linked to a pipeline", async () => {
    currentSupabase = imageCreativeClient(null);
    const res = await POST(req(VALID), { params });
    expect(res.status).toBe(409);
  });

  it("happy path: submits a corrected placement result through the worker + records the reason", async () => {
    currentSupabase = imageCreativeClient();
    specRunMock.mockResolvedValue({ ok: true });
    const res = await POST(req({ ...VALID, ratio: "1x1" }), { params });
    expect(res.status).toBe(200);

    expect(specRunMock).toHaveBeenCalledTimes(1);
    const arg = specRunMock.mock.calls[0]![0] as {
      pipeline_id: string;
      results: Array<Record<string, unknown> & { checks: Record<string, unknown> }>;
    };
    expect(arg.pipeline_id).toBe(pipelineId);
    const result = arg.results[0]!;
    expect(result).toMatchObject({
      creative_id: id,
      platform: "meta",
      placement: "feed",
      status: "pass",
      ratio: "1x1",
    });
    // The audited reason rides along in the checks jsonb.
    expect(result.checks).toMatchObject({ override: true, override_reason: VALID.reason });
  });

  it("resolves a video-store creative for the override", async () => {
    currentSupabase = mockClient({
      creatives: { select: { single: { data: null, error: null } } },
      video_creatives: {
        select: { single: { data: { id, pipeline_id: pipelineId }, error: null } },
      },
    });
    specRunMock.mockResolvedValue({ ok: true });
    const res = await POST(req(VALID), { params });
    expect(res.status).toBe(200);
  });

  it("502 when the worker errors (WorkerError)", async () => {
    currentSupabase = imageCreativeClient();
    specRunMock.mockRejectedValue(new FakeWorkerError("spec worker down", 503));
    const res = await POST(req(VALID), { params });
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe("worker_error");
  });

  it("502 when the worker is unreachable (non-WorkerError)", async () => {
    currentSupabase = imageCreativeClient();
    specRunMock.mockRejectedValue(new Error("ECONNREFUSED"));
    const res = await POST(req(VALID), { params });
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe("worker_unreachable");
  });
});

describe("GUARDRAIL: spec_check is managed — raw edit/delete refused", () => {
  it("PATCH 405 (no raw status PATCH)", () => {
    const res = PATCH();
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("POST");
  });

  it("PUT 405", () => {
    expect(PUT().status).toBe(405);
  });

  it("DELETE 405", () => {
    expect(DELETE().status).toBe(405);
  });

  it("does NOT call the worker on a refused verb", () => {
    PATCH();
    PUT();
    DELETE();
    expect(specRunMock).not.toHaveBeenCalled();
  });
});
