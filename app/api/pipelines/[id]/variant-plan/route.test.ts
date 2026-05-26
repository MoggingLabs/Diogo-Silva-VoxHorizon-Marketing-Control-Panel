/**
 * Tests for `app/api/pipelines/[id]/variant-plan/route.ts` (GET + PUT upsert).
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { mockClient } from "@/tests/unit/helpers/api-mock";
import { type SupabaseClientMock } from "@/tests/unit/helpers/supabase-mock";

let currentSupabase: SupabaseClientMock = mockClient();

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => currentSupabase,
}));

import { GET, PUT } from "./route";

const id = "11111111-1111-4111-8111-111111111111";
const params = Promise.resolve({ id });

function getReq(): NextRequest {
  return new NextRequest(new Request(`http://localhost/api/pipelines/${id}/variant-plan`));
}

function putReq(body: unknown): NextRequest {
  return new NextRequest(
    new Request(`http://localhost/api/pipelines/${id}/variant-plan`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

describe("GET /api/pipelines/:id/variant-plan", () => {
  beforeEach(() => {
    currentSupabase = mockClient();
  });

  it("200 { plan: null, cells: [] } when no plan exists", async () => {
    currentSupabase = mockClient({
      variant_plan: { select: { single: { data: null, error: null } } },
    });
    const res = await GET(getReq(), { params });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.plan).toBeNull();
    expect(body.cells).toEqual([]);
  });

  it("200 returns plan + cells when present", async () => {
    currentSupabase = mockClient({
      variant_plan: {
        select: { single: { data: { id: "vp1", status: "draft" }, error: null } },
      },
      variant_plan_cell: { select: { data: [{ id: "cell1", cell_index: 0 }], error: null } },
    });
    const res = await GET(getReq(), { params });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.plan.id).toBe("vp1");
    expect(body.cells).toHaveLength(1);
  });
});

describe("PUT /api/pipelines/:id/variant-plan", () => {
  beforeEach(() => {
    currentSupabase = mockClient();
  });

  it("201 creates a plan when none exists", async () => {
    currentSupabase = mockClient({
      variant_plan: {
        // first read (latest) -> none; then insert -> the row.
        select: { single: { data: null, error: null } },
        insert: { single: { data: { id: "vp-new", status: "draft" }, error: null } },
      },
      events: { insert: { data: null, error: null } },
    });
    const res = await PUT(putReq({ test_variable: "creative" }), { params });
    expect(res.status).toBe(201);
  });

  it("200 updates an existing draft plan", async () => {
    currentSupabase = mockClient({
      variant_plan: {
        select: { single: { data: { id: "vp1", status: "draft" }, error: null } },
        update: { single: { data: { id: "vp1", test_variable: "copy" }, error: null } },
      },
      events: { insert: { data: null, error: null } },
    });
    const res = await PUT(putReq({ test_variable: "copy", hypothesis: "h" }), { params });
    expect(res.status).toBe(200);
  });

  it("409 plan_locked when the plan is approved", async () => {
    currentSupabase = mockClient({
      variant_plan: {
        select: { single: { data: { id: "vp1", status: "approved" }, error: null } },
      },
    });
    const res = await PUT(putReq({ test_variable: "creative" }), { params });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("plan_locked");
  });

  it("400 when test_variable is invalid", async () => {
    const res = await PUT(putReq({ test_variable: "color" }), { params });
    expect(res.status).toBe(400);
  });

  it("400 on invalid JSON", async () => {
    const bad = new NextRequest(
      new Request(`http://localhost/api/pipelines/${id}/variant-plan`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: "{not json",
      }),
    );
    const res = await PUT(bad, { params });
    expect(res.status).toBe(400);
  });

  it("500 when the update fails on an existing plan", async () => {
    currentSupabase = mockClient({
      variant_plan: {
        select: { single: { data: { id: "vp1", status: "draft" }, error: null } },
        update: { single: { data: null, error: { message: "db down" } } },
      },
    });
    const res = await PUT(putReq({ test_variable: "copy" }), { params });
    expect(res.status).toBe(500);
  });

  it("500 when the insert fails creating a new plan", async () => {
    currentSupabase = mockClient({
      variant_plan: {
        select: { single: { data: null, error: null } },
        insert: { single: { data: null, error: { message: "insert failed" } } },
      },
    });
    const res = await PUT(putReq({ test_variable: "creative" }), { params });
    expect(res.status).toBe(500);
  });
});
