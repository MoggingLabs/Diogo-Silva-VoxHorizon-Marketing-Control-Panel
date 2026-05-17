/**
 * Tests for `app/api/pipelines/[id]/cancel/route.ts`.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

describe("POST /api/pipelines/:id/cancel", () => {
  beforeEach(() => {
    currentSupabase = mockClient();
  });

  it("cancels from configuration (200)", async () => {
    currentSupabase = mockClient({
      pipelines: {
        select: {
          single: { data: { id, status: "configuration", advanced_at: {} }, error: null },
        },
        update: { single: { data: { id, status: "cancelled" }, error: null } },
      },
      pipeline_events: { insert: { data: null, error: null } },
    });
    const res = await POST(req(`http://localhost/api/pipelines/${id}/cancel`, { method: "POST" }), {
      params,
    });
    expect(res.status).toBe(200);
  });

  it("cancels from generation with prior advanced_at (200)", async () => {
    currentSupabase = mockClient({
      pipelines: {
        select: {
          single: {
            data: { id, status: "generation", advanced_at: { ideation: "t1" } },
            error: null,
          },
        },
        update: { single: { data: { id, status: "cancelled" }, error: null } },
      },
      pipeline_events: { insert: { data: null, error: null } },
    });
    const res = await POST(req(`http://localhost/api/pipelines/${id}/cancel`, { method: "POST" }), {
      params,
    });
    expect(res.status).toBe(200);
  });

  it("coerces null advanced_at to empty object (200)", async () => {
    currentSupabase = mockClient({
      pipelines: {
        select: { single: { data: { id, status: "review", advanced_at: null }, error: null } },
        update: { single: { data: { id, status: "cancelled" }, error: null } },
      },
      pipeline_events: { insert: { data: null, error: null } },
    });
    const res = await POST(req(`http://localhost/api/pipelines/${id}/cancel`, { method: "POST" }), {
      params,
    });
    expect(res.status).toBe(200);
  });

  it("500 on read error", async () => {
    currentSupabase = mockClient({
      pipelines: { select: { single: { data: null, error: { message: "x" } } } },
    });
    const res = await POST(req(`http://localhost/api/pipelines/${id}/cancel`, { method: "POST" }), {
      params,
    });
    expect(res.status).toBe(500);
  });

  it("404 when missing", async () => {
    currentSupabase = mockClient({
      pipelines: { select: { single: { data: null, error: null } } },
    });
    const res = await POST(req(`http://localhost/api/pipelines/${id}/cancel`, { method: "POST" }), {
      params,
    });
    expect(res.status).toBe(404);
  });

  it("409 when already cancelled", async () => {
    currentSupabase = mockClient({
      pipelines: { select: { single: { data: { id, status: "cancelled" }, error: null } } },
    });
    const res = await POST(req(`http://localhost/api/pipelines/${id}/cancel`, { method: "POST" }), {
      params,
    });
    expect(res.status).toBe(409);
  });

  it("409 when done", async () => {
    currentSupabase = mockClient({
      pipelines: { select: { single: { data: { id, status: "done" }, error: null } } },
    });
    const res = await POST(req(`http://localhost/api/pipelines/${id}/cancel`, { method: "POST" }), {
      params,
    });
    expect(res.status).toBe(409);
  });

  it("500 when update fails", async () => {
    currentSupabase = mockClient({
      pipelines: {
        select: {
          single: { data: { id, status: "configuration", advanced_at: {} }, error: null },
        },
        update: { single: { data: null, error: { message: "race" } } },
      },
    });
    const res = await POST(req(`http://localhost/api/pipelines/${id}/cancel`, { method: "POST" }), {
      params,
    });
    expect(res.status).toBe(500);
  });

  it("warns but returns 200 when event insert fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    currentSupabase = mockClient({
      pipelines: {
        select: {
          single: { data: { id, status: "configuration", advanced_at: {} }, error: null },
        },
        update: { single: { data: { id, status: "cancelled" }, error: null } },
      },
      pipeline_events: { insert: { data: null, error: { message: "events down" } } },
    });
    const res = await POST(req(`http://localhost/api/pipelines/${id}/cancel`, { method: "POST" }), {
      params,
    });
    expect(res.status).toBe(200);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("events down"));
    warn.mockRestore();
  });
});
