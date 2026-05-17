/**
 * Tests for `app/api/pipelines/[id]/review/decision/route.ts`.
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

function req(url: string, init: RequestInit = {}): NextRequest {
  return new NextRequest(new Request(url, init));
}

beforeEach(() => {
  currentSupabase = mockClient();
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
        update: { single: { data: null, error: { message: "no" } } },
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
        update: { single: { data: null, error: { message: "no" } } },
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

  it("warns when reject event insert fails (still 200)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    currentSupabase = mockClient({
      pipelines: {
        select: {
          single: {
            data: { id, status: "review", format_choice: "image", picks: {}, advanced_at: {} },
            error: null,
          },
        },
        update: { single: { data: { id, status: "cancelled" }, error: null } },
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
    expect(res.status).toBe(200);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("warns when approve event insert fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
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
      pipeline_events: { insert: { data: null, error: { message: "ev down" } } },
    });
    const res = await POST(
      req(`http://localhost/api/pipelines/${id}/review/decision`, {
        method: "POST",
        body: JSON.stringify({ decision: "approved" }),
      }),
      { params },
    );
    expect(res.status).toBe(200);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
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
  });

  it("warns when worker kick fails (still 200)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.WORKER_URL = "http://worker.local";
    process.env.WORKER_SHARED_SECRET = "secret";
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("oops", { status: 500 }));
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
    await new Promise((r) => setTimeout(r, 5));
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("does not throw on worker 404", async () => {
    process.env.WORKER_URL = "http://worker.local";
    process.env.WORKER_SHARED_SECRET = "secret";
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(null, { status: 404 }));
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
  });

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
});
