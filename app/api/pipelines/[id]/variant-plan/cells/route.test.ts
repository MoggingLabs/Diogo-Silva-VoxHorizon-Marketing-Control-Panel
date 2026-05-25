/**
 * Tests for `app/api/pipelines/[id]/variant-plan/cells/route.ts` (POST create).
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

import { POST } from "./route";

const id = "11111111-1111-4111-8111-111111111111";
const params = Promise.resolve({ id });

function postReq(body: unknown): NextRequest {
  return new NextRequest(
    new Request(`http://localhost/api/pipelines/${id}/variant-plan/cells`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

describe("POST /api/pipelines/:id/variant-plan/cells", () => {
  beforeEach(() => {
    currentSupabase = mockClient();
  });

  it("201 appends a cell at the next free index when cell_index omitted", async () => {
    currentSupabase = mockClient({
      // resolveEditablePlan reads the plan; the next-index query also reads
      // variant_plan_cell via .maybeSingle() -> both share select.single here.
      variant_plan: { select: { single: { data: { id: "vp1", status: "draft" }, error: null } } },
      variant_plan_cell: {
        select: { single: { data: { cell_index: 2 }, error: null } },
        insert: { single: { data: { id: "cellN", cell_index: 3 }, error: null } },
      },
      events: { insert: { data: null, error: null } },
    });
    const res = await POST(postReq({ label: "B" }), { params });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.cell.id).toBe("cellN");
  });

  it("404 plan_not_found when no plan exists yet", async () => {
    currentSupabase = mockClient({
      variant_plan: { select: { single: { data: null, error: null } } },
    });
    const res = await POST(postReq({}), { params });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("plan_not_found");
  });

  it("409 plan_locked when the plan is approved", async () => {
    currentSupabase = mockClient({
      variant_plan: {
        select: { single: { data: { id: "vp1", status: "approved" }, error: null } },
      },
    });
    const res = await POST(postReq({}), { params });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("plan_locked");
  });

  it("409 duplicate_cell_index on a unique violation", async () => {
    currentSupabase = mockClient({
      variant_plan: { select: { single: { data: { id: "vp1", status: "draft" }, error: null } } },
      variant_plan_cell: {
        select: { single: { data: { cell_index: 0 }, error: null } },
        // The route detects a duplicate via the message (`duplicate key` /
        // `unique`) OR the PG code 23505; the mock's typed error shape carries
        // `message`, which is enough to exercise the 409 branch.
        insert: {
          single: { data: null, error: { message: "duplicate key value violates unique" } },
        },
      },
    });
    const res = await POST(postReq({ cell_index: 0 }), { params });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("duplicate_cell_index");
  });

  it("400 on a bad uuid", async () => {
    const res = await POST(postReq({ creative_id: "not-a-uuid" }), { params });
    expect(res.status).toBe(400);
  });
});
