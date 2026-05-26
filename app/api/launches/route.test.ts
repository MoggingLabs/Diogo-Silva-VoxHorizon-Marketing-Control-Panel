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

import { mockClient } from "@/tests/unit/helpers/api-mock";
import { type SupabaseClientMock } from "@/tests/unit/helpers/supabase-mock";

let currentSupabase: SupabaseClientMock = mockClient();
const callWorkerMock = vi.fn();

// The route imports `isOperatorDriven` from `@/lib/operator/dispatch`, which
// pulls in `server-only`; neutralise it so the jsdom route-test project can
// load the module (we use the real, pure `isOperatorDriven` implementation).
vi.mock("server-only", () => ({}));

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
    currentSupabase = mockClient();
    callWorkerMock.mockReset();
  });

  it("posts a launch package when everything is satisfied (201)", async () => {
    callWorkerMock.mockResolvedValueOnce({
      ok: true,
      issues: [],
      raw_stdout: "",
      raw_stderr: "",
    });
    currentSupabase = mockClient({
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
    currentSupabase = mockClient({
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
    currentSupabase = mockClient({
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
    currentSupabase = mockClient({
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
    currentSupabase = mockClient({
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
    currentSupabase = mockClient({
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
    currentSupabase = mockClient({
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
    currentSupabase = mockClient({
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
    currentSupabase = mockClient({
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
    currentSupabase = mockClient({
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
    currentSupabase = mockClient({
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
    currentSupabase = mockClient({
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
    currentSupabase = mockClient({
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
    currentSupabase = mockClient({
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
    currentSupabase = mockClient({
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
    currentSupabase = mockClient({
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
    currentSupabase = mockClient({
      briefs: { select: { single: { data: baseBrief, error: null } } },
      creatives: {
        select: {
          // No Drive URL AND no Supabase path → hard error (neither backend).
          data: [{ ...approvedCreative, file_path_drive: null, file_path_supabase: null }],
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

  // ── Operator/codex pipeline flow ──────────────────────────────────────────
  // Finals live in Supabase (no Drive URL), no copy variants. The route must
  // sign the Supabase asset, treat copy as optional, and post finalOk=true.
  const operatorCreative = {
    id: "55555555-5555-4555-8555-555555555555",
    concept: "before_after__roof_transformation",
    ratio: "1x1",
    version: "v1.0",
    status: "approved",
    file_path_drive: null,
    file_path_supabase: "570301a5/before-after-roof-transformation-1x1-v1.0.png",
  };

  // Mirrors the live Kris pipeline: 2 Supabase-stored finals (1x1 + 9x16,
  // v1.0, approved, no Drive URL), zero copy variants, operator-driven.
  const krisFinals = [
    operatorCreative,
    {
      ...operatorCreative,
      id: "66666666-6666-4666-8666-666666666666",
      ratio: "9x16",
      file_path_supabase: "570301a5/before-after-roof-transformation-9x16-v1.0.png",
    },
  ];

  it("operator pipeline (Kris shape): 2 Supabase finals + no copy → finalOk, asset_refs signed", async () => {
    callWorkerMock.mockRejectedValueOnce(new Error("worker offline")); // degrade to preflight
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Capture the payload written to launch_packages so we can assert the
    // package contents (validation.ok, asset_refs, issue severities).
    let insertedPayload: Record<string, unknown> | undefined;
    currentSupabase = mockClient({
      pipelines: {
        select: {
          single: {
            data: { id: pipelineId, status: "done", config_draft: { operator_driven: true } },
            error: null,
          },
        },
        update: { data: null, error: null },
      },
      briefs: { select: { single: { data: baseBrief, error: null } } },
      creatives: { select: { data: krisFinals, error: null } },
      copy_variants: { select: { data: [], error: null } },
      launch_packages: {
        insert: { single: { data: { id: "lpkris", status: "posted" }, error: null } },
      },
      events: { insert: { data: null, error: null } },
      pipeline_events: { insert: { data: null, error: null } },
    });
    const realFrom = currentSupabase.from;
    currentSupabase.from = vi.fn((table: string) => {
      const builder = realFrom(table) as { insert: (row: unknown) => unknown };
      if (table === "launch_packages") {
        const realInsert = builder.insert.bind(builder);
        builder.insert = (row: unknown) => {
          insertedPayload = (row as { payload: Record<string, unknown> }).payload;
          return realInsert(row);
        };
      }
      return builder;
    }) as typeof currentSupabase.from;

    const res = await POST(
      req("http://localhost/api/launches", {
        method: "POST",
        body: JSON.stringify({ brief_id: briefId, pipeline_id: pipelineId }),
      }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.launch.id).toBe("lpkris");
    expect(body.launch.status).toBe("posted");

    // Package assertions: finalOk path → validation.ok true, both finals
    // attached as signed Supabase asset refs, and no error-severity issues.
    expect(insertedPayload).toBeDefined();
    const p = insertedPayload as {
      validation: { ok: boolean };
      asset_refs: { creative_id: string; source: string; url: string | null }[];
      creative_ids: string[];
      issues: { severity: string }[];
    };
    expect(p.validation.ok).toBe(true);
    expect(p.creative_ids).toHaveLength(2);
    expect(p.asset_refs).toHaveLength(2);
    expect(p.asset_refs.every((a) => a.source === "supabase" && a.url !== null)).toBe(true);
    expect(p.issues.some((i) => i.severity === "error")).toBe(false);
    warn.mockRestore();
  });

  it("operator pipeline: warns (not errors) when Supabase asset fails to sign, still 201", async () => {
    callWorkerMock.mockRejectedValueOnce(new Error("worker offline"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    currentSupabase = mockClient(
      {
        pipelines: {
          select: {
            single: {
              data: {
                id: pipelineId,
                status: "done",
                config_draft: { operator_driven: true },
              },
              error: null,
            },
          },
          update: { data: null, error: null },
        },
        briefs: { select: { single: { data: baseBrief, error: null } } },
        creatives: { select: { data: [operatorCreative], error: null } },
        copy_variants: { select: { data: [], error: null } },
        launch_packages: {
          insert: { single: { data: { id: "lpop2", status: "posted" }, error: null } },
        },
        events: { insert: { data: null, error: null } },
        pipeline_events: { insert: { data: null, error: null } },
      },
      { storageSign: () => null }, // simulate a sign failure → warning, not error
    );
    const res = await POST(
      req("http://localhost/api/launches", {
        method: "POST",
        body: JSON.stringify({ brief_id: briefId, pipeline_id: pipelineId }),
      }),
    );
    // Sign failure is a warning, missing copy is a warning → no error severity.
    expect(res.status).toBe(201);
    warn.mockRestore();
  });

  it("non-operator pipeline: missing copy variants is still a hard error (422)", async () => {
    callWorkerMock.mockRejectedValueOnce(new Error("worker offline"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    currentSupabase = mockClient({
      pipelines: {
        select: {
          single: {
            data: { id: pipelineId, status: "done", config_draft: {} },
            error: null,
          },
        },
      },
      briefs: { select: { single: { data: baseBrief, error: null } } },
      // Drive URL present (legacy) but no copy variants.
      creatives: { select: { data: [approvedCreative], error: null } },
      copy_variants: { select: { data: [], error: null } },
      launch_packages: {
        insert: { single: { data: { id: "lpop3", status: "failed" }, error: null } },
      },
      events: { insert: { data: null, error: null } },
    });
    const res = await POST(
      req("http://localhost/api/launches", {
        method: "POST",
        body: JSON.stringify({ brief_id: briefId, pipeline_id: pipelineId }),
      }),
    );
    expect(res.status).toBe(422);
    warn.mockRestore();
  });
});

describe("GET /api/launches", () => {
  beforeEach(() => {
    currentSupabase = mockClient();
  });

  it("returns list (200)", async () => {
    currentSupabase = mockClient({
      launch_packages: { select: { data: [{ id: "lp1" }], error: null } },
    });
    const res = await GET(req("http://localhost/api/launches"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.launches).toHaveLength(1);
  });

  it("applies brief_id + status filters", async () => {
    currentSupabase = mockClient({
      launch_packages: { select: { data: [], error: null } },
    });
    const res = await GET(req(`http://localhost/api/launches?brief_id=${briefId}&status=posted`));
    expect(res.status).toBe(200);
  });

  it("archived=true lists the archived set (200)", async () => {
    currentSupabase = mockClient({
      launch_packages: { select: { data: [{ id: "lp-arch" }], error: null } },
    });
    const res = await GET(req("http://localhost/api/launches?archived=true"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.launches).toHaveLength(1);
  });

  it("500 on supabase error", async () => {
    currentSupabase = mockClient({
      launch_packages: { select: { data: null, error: { message: "x" } } },
    });
    const res = await GET(req("http://localhost/api/launches"));
    expect(res.status).toBe(500);
  });
});
