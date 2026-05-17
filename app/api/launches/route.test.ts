/**
 * Tests for `app/api/launches/route.ts` (POST + GET).
 *
 * The route runs preflight against briefs / creatives / copy_variants, then
 * calls the worker (`lib/worker.callWorker`). We mock both the admin
 * Supabase client and the worker module so each branch — happy path,
 * validation, missing brief, brief in wrong state, preflight failures,
 * worker degrades — exercises in isolation.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { mockSupabaseClient, type SupabaseClientMock } from "@/tests/unit/helpers/supabase-mock";

let currentSupabase: SupabaseClientMock = mockSupabaseClient();
const callWorkerMock = vi.fn();

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => currentSupabase,
}));
vi.mock("@/lib/worker", () => {
  class WorkerError extends Error {
    status?: number;
    cause?: unknown;
    constructor(message: string, status?: number, cause?: unknown) {
      super(message);
      this.name = "WorkerError";
      this.status = status;
      this.cause = cause;
    }
  }
  return {
    callWorker: (...args: unknown[]) => callWorkerMock(...args),
    WorkerError,
    worker: { health: () => Promise.resolve({ ok: true }) },
  };
});

import { GET, POST } from "./route";

const briefId = "11111111-1111-4111-8111-111111111111";
const pipelineId = "22222222-2222-4222-8222-222222222222";

function req(url: string, init: RequestInit = {}): NextRequest {
  return new NextRequest(new Request(url, init));
}

const baseBrief = {
  id: briefId,
  brief_id_human: "ACME-2026-0001",
  status: "approved",
  payload: {},
  client_id: "c1",
  clients: { id: "c1", slug: "acme", name: "Acme" },
};

const approvedCreative = {
  id: "33333333-3333-4333-8333-333333333333",
  concept: "v1",
  ratio: "1x1",
  version: "v1.0",
  status: "approved",
  file_path_drive: "https://drive.google.com/x",
  file_path_supabase: "s/x",
};

const copyVariant = {
  id: "44444444-4444-4444-8444-444444444444",
  creative_id: "33333333-3333-4333-8333-333333333333",
  headline: "h",
  body: "b",
  cta: "go",
  status: "approved",
};

describe("POST /api/launches", () => {
  beforeEach(() => {
    currentSupabase = mockSupabaseClient();
    callWorkerMock.mockReset();
  });

  it("posts a launch package when everything is satisfied (201)", async () => {
    callWorkerMock.mockResolvedValueOnce({
      ok: true,
      issues: [],
      raw_stdout: "",
      raw_stderr: "",
    });
    currentSupabase = mockSupabaseClient({
      briefs: { select: { single: { data: baseBrief, error: null } } },
      creatives: { select: { data: [approvedCreative], error: null } },
      copy_variants: { select: { data: [copyVariant], error: null } },
      launch_packages: {
        insert: { single: { data: { id: "lp1", status: "posted" }, error: null } },
      },
      events: { insert: { data: null, error: null } },
    });

    const res = await POST(
      req("http://localhost/api/launches", {
        method: "POST",
        body: JSON.stringify({ brief_id: briefId }),
      }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.launch.id).toBe("lp1");
  });

  it("422 when preflight reports issues (no creatives)", async () => {
    callWorkerMock.mockResolvedValueOnce({ ok: true, issues: [] });
    currentSupabase = mockSupabaseClient({
      briefs: { select: { single: { data: baseBrief, error: null } } },
      creatives: { select: { data: [], error: null } },
      launch_packages: {
        insert: { single: { data: { id: "lp1", status: "failed" }, error: null } },
      },
      events: { insert: { data: null, error: null } },
    });
    const res = await POST(
      req("http://localhost/api/launches", {
        method: "POST",
        body: JSON.stringify({ brief_id: briefId }),
      }),
    );
    expect(res.status).toBe(422);
  });

  it("returns 422 when worker reports its own issues (non-ok)", async () => {
    callWorkerMock.mockResolvedValueOnce({
      ok: false,
      issues: ["bad copy"],
    });
    currentSupabase = mockSupabaseClient({
      briefs: { select: { single: { data: baseBrief, error: null } } },
      creatives: { select: { data: [approvedCreative], error: null } },
      copy_variants: { select: { data: [copyVariant], error: null } },
      launch_packages: {
        insert: { single: { data: { id: "lp2", status: "failed" }, error: null } },
      },
      events: { insert: { data: null, error: null } },
    });
    const res = await POST(
      req("http://localhost/api/launches", {
        method: "POST",
        body: JSON.stringify({ brief_id: briefId }),
      }),
    );
    expect(res.status).toBe(422);
  });

  it("degrades when worker is unavailable (still 201 if preflight ok)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { WorkerError } = (await import("@/lib/worker")) as unknown as {
      WorkerError: new (msg: string, status?: number) => Error;
    };
    callWorkerMock.mockRejectedValueOnce(new WorkerError("offline", 503));
    currentSupabase = mockSupabaseClient({
      briefs: { select: { single: { data: baseBrief, error: null } } },
      creatives: { select: { data: [approvedCreative], error: null } },
      copy_variants: { select: { data: [copyVariant], error: null } },
      launch_packages: {
        insert: { single: { data: { id: "lp3", status: "posted" }, error: null } },
      },
      events: { insert: { data: null, error: null } },
    });
    const res = await POST(
      req("http://localhost/api/launches", {
        method: "POST",
        body: JSON.stringify({ brief_id: briefId }),
      }),
    );
    expect(res.status).toBe(201);
    warn.mockRestore();
  });

  it("logs but degrades on non-WorkerError throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    callWorkerMock.mockRejectedValueOnce(new Error("rando"));
    currentSupabase = mockSupabaseClient({
      briefs: { select: { single: { data: baseBrief, error: null } } },
      creatives: { select: { data: [approvedCreative], error: null } },
      copy_variants: { select: { data: [copyVariant], error: null } },
      launch_packages: {
        insert: { single: { data: { id: "lp4", status: "posted" }, error: null } },
      },
      events: { insert: { data: null, error: null } },
    });
    const res = await POST(
      req("http://localhost/api/launches", {
        method: "POST",
        body: JSON.stringify({ brief_id: briefId }),
      }),
    );
    expect(res.status).toBe(201);
    warn.mockRestore();
  });

  it("400 invalid JSON", async () => {
    const res = await POST(req("http://localhost/api/launches", { method: "POST", body: "{" }));
    expect(res.status).toBe(400);
  });

  it("400 validation_failed when brief_id missing", async () => {
    const res = await POST(
      req("http://localhost/api/launches", { method: "POST", body: JSON.stringify({}) }),
    );
    expect(res.status).toBe(400);
  });

  it("500 when brief select errors", async () => {
    currentSupabase = mockSupabaseClient({
      briefs: { select: { single: { data: null, error: { message: "x" } } } },
    });
    const res = await POST(
      req("http://localhost/api/launches", {
        method: "POST",
        body: JSON.stringify({ brief_id: briefId }),
      }),
    );
    expect(res.status).toBe(500);
  });

  it("404 when brief missing", async () => {
    currentSupabase = mockSupabaseClient({
      briefs: { select: { single: { data: null, error: null } } },
    });
    const res = await POST(
      req("http://localhost/api/launches", {
        method: "POST",
        body: JSON.stringify({ brief_id: briefId }),
      }),
    );
    expect(res.status).toBe(404);
  });

  it("409 when brief in wrong state", async () => {
    currentSupabase = mockSupabaseClient({
      briefs: {
        select: { single: { data: { ...baseBrief, status: "draft" }, error: null } },
      },
    });
    const res = await POST(
      req("http://localhost/api/launches", {
        method: "POST",
        body: JSON.stringify({ brief_id: briefId }),
      }),
    );
    expect(res.status).toBe(409);
  });

  it("500 when creatives select errors", async () => {
    currentSupabase = mockSupabaseClient({
      briefs: { select: { single: { data: baseBrief, error: null } } },
      creatives: { select: { data: null, error: { message: "x" } } },
    });
    const res = await POST(
      req("http://localhost/api/launches", {
        method: "POST",
        body: JSON.stringify({ brief_id: briefId }),
      }),
    );
    expect(res.status).toBe(500);
  });

  it("500 when copy_variants select errors", async () => {
    currentSupabase = mockSupabaseClient({
      briefs: { select: { single: { data: baseBrief, error: null } } },
      creatives: { select: { data: [approvedCreative], error: null } },
      copy_variants: { select: { data: null, error: { message: "x" } } },
    });
    const res = await POST(
      req("http://localhost/api/launches", {
        method: "POST",
        body: JSON.stringify({ brief_id: briefId }),
      }),
    );
    expect(res.status).toBe(500);
  });

  it("validates pipeline_id — 500 on read err", async () => {
    currentSupabase = mockSupabaseClient({
      pipelines: { select: { single: { data: null, error: { message: "x" } } } },
    });
    const res = await POST(
      req("http://localhost/api/launches", {
        method: "POST",
        body: JSON.stringify({ brief_id: briefId, pipeline_id: pipelineId }),
      }),
    );
    expect(res.status).toBe(500);
  });

  it("404 when pipeline_id is unknown", async () => {
    currentSupabase = mockSupabaseClient({
      pipelines: { select: { single: { data: null, error: null } } },
    });
    const res = await POST(
      req("http://localhost/api/launches", {
        method: "POST",
        body: JSON.stringify({ brief_id: briefId, pipeline_id: pipelineId }),
      }),
    );
    expect(res.status).toBe(404);
  });

  it("422 when pipeline_id not in `done`", async () => {
    currentSupabase = mockSupabaseClient({
      pipelines: {
        select: { single: { data: { id: pipelineId, status: "review" }, error: null } },
      },
    });
    const res = await POST(
      req("http://localhost/api/launches", {
        method: "POST",
        body: JSON.stringify({ brief_id: briefId, pipeline_id: pipelineId }),
      }),
    );
    expect(res.status).toBe(422);
  });

  it("happy path with pipeline link writes back to pipelines", async () => {
    callWorkerMock.mockResolvedValueOnce({ ok: true, issues: [] });
    // Multiple `pipelines` selects (initial guard + update) — both return
    // `done`. The mock builder reuses the same response across calls.
    currentSupabase = mockSupabaseClient({
      pipelines: {
        select: { single: { data: { id: pipelineId, status: "done" }, error: null } },
        update: { data: null, error: null },
      },
      briefs: { select: { single: { data: baseBrief, error: null } } },
      creatives: { select: { data: [approvedCreative], error: null } },
      copy_variants: { select: { data: [copyVariant], error: null } },
      launch_packages: {
        insert: { single: { data: { id: "lp10", status: "posted" }, error: null } },
      },
      events: { insert: { data: null, error: null } },
      pipeline_events: { insert: { data: null, error: null } },
    });
    const res = await POST(
      req("http://localhost/api/launches", {
        method: "POST",
        body: JSON.stringify({ brief_id: briefId, pipeline_id: pipelineId }),
      }),
    );
    expect(res.status).toBe(201);
  });

  it("warns when pipeline back-link update fails (still 201)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    callWorkerMock.mockResolvedValueOnce({ ok: true, issues: [] });
    currentSupabase = mockSupabaseClient({
      pipelines: {
        select: { single: { data: { id: pipelineId, status: "done" }, error: null } },
        update: { data: null, error: { message: "link broke" } },
      },
      briefs: { select: { single: { data: baseBrief, error: null } } },
      creatives: { select: { data: [approvedCreative], error: null } },
      copy_variants: { select: { data: [copyVariant], error: null } },
      launch_packages: {
        insert: { single: { data: { id: "lp11", status: "posted" }, error: null } },
      },
      events: { insert: { data: null, error: null } },
      pipeline_events: { insert: { data: null, error: { message: "ev fail" } } },
    });
    const res = await POST(
      req("http://localhost/api/launches", {
        method: "POST",
        body: JSON.stringify({ brief_id: briefId, pipeline_id: pipelineId }),
      }),
    );
    expect(res.status).toBe(201);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("500 when launch_packages insert fails", async () => {
    callWorkerMock.mockResolvedValueOnce({ ok: true, issues: [] });
    currentSupabase = mockSupabaseClient({
      briefs: { select: { single: { data: baseBrief, error: null } } },
      creatives: { select: { data: [approvedCreative], error: null } },
      copy_variants: { select: { data: [copyVariant], error: null } },
      launch_packages: {
        insert: { single: { data: null, error: { message: "dup" } } },
      },
    });
    const res = await POST(
      req("http://localhost/api/launches", {
        method: "POST",
        body: JSON.stringify({ brief_id: briefId }),
      }),
    );
    expect(res.status).toBe(500);
  });

  it("appends issues for creatives missing drive URL or copy variants", async () => {
    callWorkerMock.mockResolvedValueOnce({ ok: true, issues: [] });
    currentSupabase = mockSupabaseClient({
      briefs: { select: { single: { data: baseBrief, error: null } } },
      creatives: {
        select: {
          data: [{ ...approvedCreative, file_path_drive: null }],
          error: null,
        },
      },
      copy_variants: { select: { data: [], error: null } },
      launch_packages: {
        insert: { single: { data: { id: "lp99", status: "failed" }, error: null } },
      },
      events: { insert: { data: null, error: null } },
    });
    const res = await POST(
      req("http://localhost/api/launches", {
        method: "POST",
        body: JSON.stringify({ brief_id: briefId }),
      }),
    );
    expect(res.status).toBe(422);
  });
});

describe("GET /api/launches", () => {
  beforeEach(() => {
    currentSupabase = mockSupabaseClient();
  });

  it("returns list (200)", async () => {
    currentSupabase = mockSupabaseClient({
      launch_packages: { select: { data: [{ id: "lp1" }], error: null } },
    });
    const res = await GET(req("http://localhost/api/launches"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.launches).toHaveLength(1);
  });

  it("applies brief_id + status filters", async () => {
    currentSupabase = mockSupabaseClient({
      launch_packages: { select: { data: [], error: null } },
    });
    const res = await GET(req(`http://localhost/api/launches?brief_id=${briefId}&status=posted`));
    expect(res.status).toBe(200);
  });

  it("500 on supabase error", async () => {
    currentSupabase = mockSupabaseClient({
      launch_packages: { select: { data: null, error: { message: "x" } } },
    });
    const res = await GET(req("http://localhost/api/launches"));
    expect(res.status).toBe(500);
  });
});
