/**
 * Tests for `app/api/pipelines/[id]/variant-plan/cells/[cellId]/route.ts`
 * (PATCH edit + DELETE hard-delete).
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

import { DELETE, PATCH } from "./route";

const id = "11111111-1111-4111-8111-111111111111";
const cellId = "22222222-2222-4222-9222-222222222222";
const params = Promise.resolve({ id, cellId });

function patchReq(body: unknown): NextRequest {
  return new NextRequest(
    new Request(`http://localhost/api/pipelines/${id}/variant-plan/cells/${cellId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

function delReq(): NextRequest {
  return new NextRequest(
    new Request(`http://localhost/api/pipelines/${id}/variant-plan/cells/${cellId}`, {
      method: "DELETE",
    }),
  );
}

describe("PATCH /api/pipelines/:id/variant-plan/cells/:cellId", () => {
  beforeEach(() => {
    currentSupabase = mockClient();
  });

  it("200 edits a cell of a draft plan", async () => {
    currentSupabase = mockClient({
      variant_plan: { select: { single: { data: { id: "vp1", status: "draft" }, error: null } } },
      variant_plan_cell: {
        // guardCell reads the cell first; then the update returns the new row.
        select: { single: { data: { id: cellId, variant_plan_id: "vp1" }, error: null } },
        update: { single: { data: { id: cellId, label: "A" }, error: null } },
      },
      events: { insert: { data: null, error: null } },
    });
    const res = await PATCH(patchReq({ label: "A" }), { params });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cell.label).toBe("A");
  });

  it("409 plan_locked when approved", async () => {
    currentSupabase = mockClient({
      variant_plan: {
        select: { single: { data: { id: "vp1", status: "approved" }, error: null } },
      },
    });
    const res = await PATCH(patchReq({ label: "A" }), { params });
    expect(res.status).toBe(409);
  });

  it("404 cell_not_found when the cell is under a different plan", async () => {
    currentSupabase = mockClient({
      variant_plan: { select: { single: { data: { id: "vp1", status: "draft" }, error: null } } },
      variant_plan_cell: {
        select: { single: { data: { id: cellId, variant_plan_id: "OTHER" }, error: null } },
      },
    });
    const res = await PATCH(patchReq({ label: "A" }), { params });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("cell_not_found");
  });

  it("400 when the body is empty (nothing to update)", async () => {
    const res = await PATCH(patchReq({}), { params });
    expect(res.status).toBe(400);
  });

  it("404 plan_not_found when no plan exists", async () => {
    currentSupabase = mockClient({
      variant_plan: { select: { single: { data: null, error: null } } },
    });
    const res = await PATCH(patchReq({ label: "A" }), { params });
    expect(res.status).toBe(404);
  });

  it("200 applies all editable fields (index/creative/copy/audience)", async () => {
    currentSupabase = mockClient({
      variant_plan: { select: { single: { data: { id: "vp1", status: "draft" }, error: null } } },
      variant_plan_cell: {
        select: { single: { data: { id: cellId, variant_plan_id: "vp1" }, error: null } },
        update: { single: { data: { id: cellId, cell_index: 2 }, error: null } },
      },
      events: { insert: { data: null, error: null } },
    });
    const res = await PATCH(
      patchReq({
        cell_index: 2,
        creative_id: "33333333-3333-4333-8333-333333333333",
        copy_variant_id: "44444444-4444-4444-8444-444444444444",
        audience: { country: "US" },
      }),
      { params },
    );
    expect(res.status).toBe(200);
  });

  it("409 duplicate_cell_index on a unique violation", async () => {
    currentSupabase = mockClient({
      variant_plan: { select: { single: { data: { id: "vp1", status: "draft" }, error: null } } },
      variant_plan_cell: {
        select: { single: { data: { id: cellId, variant_plan_id: "vp1" }, error: null } },
        update: {
          single: { data: null, error: { message: "duplicate key value violates unique" } },
        },
      },
    });
    const res = await PATCH(patchReq({ cell_index: 0 }), { params });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("duplicate_cell_index");
  });

  it("500 on a non-unique DB error during update", async () => {
    currentSupabase = mockClient({
      variant_plan: { select: { single: { data: { id: "vp1", status: "draft" }, error: null } } },
      variant_plan_cell: {
        select: { single: { data: { id: cellId, variant_plan_id: "vp1" }, error: null } },
        update: { single: { data: null, error: { message: "connection lost" } } },
      },
    });
    const res = await PATCH(patchReq({ label: "A" }), { params });
    expect(res.status).toBe(500);
  });

  it("400 on a bad uuid", async () => {
    const res = await PATCH(patchReq({ creative_id: "nope" }), { params });
    expect(res.status).toBe(400);
  });
});

describe("DELETE /api/pipelines/:id/variant-plan/cells/:cellId", () => {
  beforeEach(() => {
    currentSupabase = mockClient();
  });

  it("200 hard-deletes a cell of a draft plan", async () => {
    currentSupabase = mockClient({
      variant_plan: { select: { single: { data: { id: "vp1", status: "draft" }, error: null } } },
      variant_plan_cell: {
        select: { single: { data: { id: cellId, variant_plan_id: "vp1" }, error: null } },
        delete: { single: { data: { id: cellId }, error: null } },
      },
      events: { insert: { data: null, error: null } },
    });
    const res = await DELETE(delReq(), { params });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cell.id).toBe(cellId);
  });

  it("409 plan_locked when approved", async () => {
    currentSupabase = mockClient({
      variant_plan: {
        select: { single: { data: { id: "vp1", status: "approved" }, error: null } },
      },
    });
    const res = await DELETE(delReq(), { params });
    expect(res.status).toBe(409);
  });

  it("404 cell_not_found when the cell is not under this plan", async () => {
    currentSupabase = mockClient({
      variant_plan: { select: { single: { data: { id: "vp1", status: "draft" }, error: null } } },
      variant_plan_cell: {
        select: { single: { data: null, error: null } },
      },
    });
    const res = await DELETE(delReq(), { params });
    expect(res.status).toBe(404);
  });

  it("500 on a DB error during hard-delete", async () => {
    currentSupabase = mockClient({
      variant_plan: { select: { single: { data: { id: "vp1", status: "draft" }, error: null } } },
      variant_plan_cell: {
        select: { single: { data: { id: cellId, variant_plan_id: "vp1" }, error: null } },
        delete: { single: { data: null, error: { message: "boom" } } },
      },
    });
    const res = await DELETE(delReq(), { params });
    expect(res.status).toBe(500);
  });
});
