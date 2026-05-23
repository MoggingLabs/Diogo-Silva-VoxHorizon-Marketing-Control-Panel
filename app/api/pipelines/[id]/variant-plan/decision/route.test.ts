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

  it("warns when plan/event updates fail but still succeeds", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    currentSupabase = mockClient({
      pipelines: {
        select: {
          single: { data: { id, status: "variant_plan", advanced_at: null }, error: null },
        },
        update: { single: { data: { id, status: "finalize_assets" }, error: null } },
      },
      variant_plan: { update: { data: null, error: { message: "plan down" } } },
      pipeline_events: { insert: { data: null, error: { message: "ev down" } } },
    });
    const res = await POST(req({ decision: "approved" }), { params });
    expect(res.status).toBe(200);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
