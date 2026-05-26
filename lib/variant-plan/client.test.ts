import { afterEach, describe, expect, it, vi } from "vitest";

import { jsonResponse, spyOnFetch } from "@/tests/unit/helpers/worker-mock";
import {
  createVariantPlanCell,
  deleteVariantPlanCell,
  updateVariantPlanCell,
  upsertVariantPlan,
} from "./client";

afterEach(() => vi.restoreAllMocks());

describe("lib/variant-plan/client", () => {
  it("upsertVariantPlan PUTs the plan and returns it", async () => {
    const spy = spyOnFetch();
    spy.mockResolvedValueOnce(jsonResponse({ plan: { id: "vp1", status: "draft" } }));
    const plan = await upsertVariantPlan("p1", { test_variable: "creative", hypothesis: "h" });
    expect(plan.id).toBe("vp1");
    const [url, init] = spy.mock.calls[0]!;
    expect(String(url)).toBe("/api/pipelines/p1/variant-plan");
    expect((init as RequestInit).method).toBe("PUT");
  });

  it("createVariantPlanCell POSTs to the cells endpoint", async () => {
    const spy = spyOnFetch();
    spy.mockResolvedValueOnce(jsonResponse({ cell: { id: "c1" } }, { status: 201 }));
    const cell = await createVariantPlanCell("p1", { label: "A" });
    expect(cell.id).toBe("c1");
    expect(String(spy.mock.calls[0]![0])).toBe("/api/pipelines/p1/variant-plan/cells");
    expect((spy.mock.calls[0]![1] as RequestInit).method).toBe("POST");
  });

  it("updateVariantPlanCell PATCHes a cell", async () => {
    const spy = spyOnFetch();
    spy.mockResolvedValueOnce(jsonResponse({ cell: { id: "c1", label: "B" } }));
    await updateVariantPlanCell("p1", "c1", { label: "B" });
    const [url, init] = spy.mock.calls[0]!;
    expect(String(url)).toBe("/api/pipelines/p1/variant-plan/cells/c1");
    expect((init as RequestInit).method).toBe("PATCH");
  });

  it("deleteVariantPlanCell DELETEs a cell", async () => {
    const spy = spyOnFetch();
    spy.mockResolvedValueOnce(jsonResponse({ cell: { id: "c1" } }));
    await deleteVariantPlanCell("p1", "c1");
    const [url, init] = spy.mock.calls[0]!;
    expect(String(url)).toBe("/api/pipelines/p1/variant-plan/cells/c1");
    expect((init as RequestInit).method).toBe("DELETE");
  });

  it("surfaces the error + reason from a non-2xx body", async () => {
    const spy = spyOnFetch();
    spy.mockResolvedValueOnce(
      jsonResponse({ error: "plan_locked", reason: "re-open first" }, { status: 409 }),
    );
    await expect(createVariantPlanCell("p1", {})).rejects.toThrow(/plan_locked: re-open first/);
  });
});
