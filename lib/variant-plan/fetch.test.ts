/**
 * Tests for `lib/variant-plan/fetch.ts`: latestVariantPlan, resolveEditablePlan,
 * and getVariantPlanEditorData.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { mockClient } from "@/tests/unit/helpers/api-mock";
import { type SupabaseClientMock } from "@/tests/unit/helpers/supabase-mock";

let currentSupabase: SupabaseClientMock = mockClient();

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => currentSupabase,
}));

import { getVariantPlanEditorData, latestVariantPlan, resolveEditablePlan } from "./fetch";

describe("latestVariantPlan", () => {
  beforeEach(() => {
    currentSupabase = mockClient();
  });

  it("returns the latest plan row", async () => {
    currentSupabase = mockClient({
      variant_plan: { select: { single: { data: { id: "vp1", status: "draft" }, error: null } } },
    });
    const plan = await latestVariantPlan(currentSupabase as never, "p1");
    expect(plan?.id).toBe("vp1");
  });

  it("returns null when there is no plan", async () => {
    currentSupabase = mockClient({
      variant_plan: { select: { single: { data: null, error: null } } },
    });
    expect(await latestVariantPlan(currentSupabase as never, "p1")).toBeNull();
  });
});

describe("resolveEditablePlan", () => {
  beforeEach(() => {
    currentSupabase = mockClient();
  });

  it("ok for a draft plan", async () => {
    currentSupabase = mockClient({
      variant_plan: { select: { single: { data: { id: "vp1", status: "draft" }, error: null } } },
    });
    const res = await resolveEditablePlan(currentSupabase as never, "p1");
    expect(res.kind).toBe("ok");
  });

  it("missing when no plan exists", async () => {
    currentSupabase = mockClient({
      variant_plan: { select: { single: { data: null, error: null } } },
    });
    const res = await resolveEditablePlan(currentSupabase as never, "p1");
    expect(res.kind).toBe("missing");
  });

  it("locked when the plan is approved", async () => {
    currentSupabase = mockClient({
      variant_plan: {
        select: { single: { data: { id: "vp1", status: "approved" }, error: null } },
      },
    });
    const res = await resolveEditablePlan(currentSupabase as never, "p1");
    expect(res.kind).toBe("locked");
  });
});

describe("getVariantPlanEditorData", () => {
  beforeEach(() => {
    currentSupabase = mockClient();
  });

  it("loads plan + cells + creatives + copy variants", async () => {
    currentSupabase = mockClient({
      variant_plan: { select: { single: { data: { id: "vp1", status: "draft" }, error: null } } },
      variant_plan_cell: { select: { data: [{ id: "c1", cell_index: 0 }], error: null } },
      creatives: { select: { data: [{ id: "cr1", concept: "Hero" }], error: null } },
      copy_variants: {
        select: {
          data: [{ id: "cv1", creative_id: "cr1", headline: "H", variant_index: 0 }],
          error: null,
        },
      },
    });
    const data = await getVariantPlanEditorData("p1");
    expect(data.plan?.id).toBe("vp1");
    expect(data.cells).toHaveLength(1);
    expect(data.creatives).toHaveLength(1);
    expect(data.copyVariants).toHaveLength(1);
  });

  it("skips the cells query and returns empty cells when no plan exists", async () => {
    currentSupabase = mockClient({
      variant_plan: { select: { single: { data: null, error: null } } },
      creatives: { select: { data: [], error: null } },
      copy_variants: { select: { data: [], error: null } },
    });
    const data = await getVariantPlanEditorData("p1");
    expect(data.plan).toBeNull();
    expect(data.cells).toEqual([]);
  });
});
