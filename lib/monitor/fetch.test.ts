import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mockClient } from "@/tests/unit/helpers/api-mock";
import { type SupabaseClientMock } from "@/tests/unit/helpers/supabase-mock";

vi.mock("server-only", () => ({}));

let currentSupabase: SupabaseClientMock = mockClient();
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => currentSupabase,
}));

import { applyPerfOverrides, getMonitorRows, type PerfRowWithId } from "./fetch";

beforeEach(() => {
  currentSupabase = mockClient();
});
afterEach(() => vi.restoreAllMocks());

describe("getMonitorRows", () => {
  it("returns the perf rows for a pipeline", async () => {
    currentSupabase = mockClient({
      campaign_perf_image: {
        select: {
          data: [{ id: "r1", campaign_id: "c1", spend: 100, leads_ghl: 2, leads_meta: 3 }],
        },
      },
    });
    const rows = await getMonitorRows("p1");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.campaign_id).toBe("c1");
  });

  it("returns [] when there is no data", async () => {
    expect(await getMonitorRows("p1")).toEqual([]);
  });

  it("overlays operator corrections from the overrides table over the source rows", async () => {
    currentSupabase = mockClient({
      campaign_perf_image: {
        select: {
          data: [{ id: "r1", campaign_id: "c1", spend: 100, leads_ghl: 2, leads_meta: 3 }],
        },
      },
      overrides: {
        select: {
          data: [{ row_id: "r1", field_name: "spend", corrected_value: 250 }],
        },
      },
    });
    const rows = await getMonitorRows("p1");
    // The corrected spend is applied over the source value.
    expect(rows[0]!.spend).toBe(250);
    // Untouched fields keep the source value.
    expect(rows[0]!.leads_ghl).toBe(2);
  });
});

describe("applyPerfOverrides", () => {
  const base: PerfRowWithId[] = [
    {
      id: "r1",
      campaign_id: "c1",
      spend: 100,
      leads_ghl: 2,
      leads_meta: 3,
      ctr: 0.01,
      freq: 1.1,
      cpl_real: null,
    },
    {
      id: "r2",
      campaign_id: "c2",
      spend: 200,
      leads_ghl: 4,
      leads_meta: 5,
      ctr: 0.02,
      freq: 1.3,
      cpl_real: null,
    },
  ];

  it("returns the rows unchanged when there are no overrides", () => {
    expect(applyPerfOverrides(base, [])).toBe(base);
  });

  it("applies a numeric correction to the matching row + field only", () => {
    const out = applyPerfOverrides(base, [
      { row_id: "r2", field_name: "leads_ghl", corrected_value: 9 },
    ]);
    expect(out[1]!.leads_ghl).toBe(9);
    // Other row untouched (and is the same reference — no needless copy).
    expect(out[0]).toBe(base[0]);
  });

  it("coerces a numeric string correction", () => {
    const out = applyPerfOverrides(base, [
      { row_id: "r1", field_name: "spend", corrected_value: "150.5" },
    ]);
    expect(out[0]!.spend).toBe(150.5);
  });

  it("treats an empty-string correction as null (cleared)", () => {
    const out = applyPerfOverrides(base, [
      { row_id: "r1", field_name: "spend", corrected_value: "" },
    ]);
    expect(out[0]!.spend).toBeNull();
  });

  it("applies an explicit null correction", () => {
    const out = applyPerfOverrides(base, [
      { row_id: "r1", field_name: "leads_meta", corrected_value: null },
    ]);
    expect(out[0]!.leads_meta).toBeNull();
  });

  it("ignores a correction that doesn't parse to a finite number", () => {
    const out = applyPerfOverrides(base, [
      { row_id: "r1", field_name: "spend", corrected_value: "not-a-number" },
    ]);
    expect(out[0]!.spend).toBe(100);
  });

  it("ignores a non-string/non-number correction (e.g. an object)", () => {
    const out = applyPerfOverrides(base, [
      { row_id: "r1", field_name: "spend", corrected_value: { nope: true } },
    ]);
    expect(out[0]!.spend).toBe(100);
  });

  it("ignores NaN/Infinity numeric corrections", () => {
    const out = applyPerfOverrides(base, [
      { row_id: "r1", field_name: "spend", corrected_value: Number.POSITIVE_INFINITY },
    ]);
    expect(out[0]!.spend).toBe(100);
  });

  it("ignores corrections for fields outside the overlay whitelist", () => {
    const out = applyPerfOverrides(base, [
      { row_id: "r1", field_name: "verdict", corrected_value: "kill" },
      { row_id: "r1", field_name: "campaign_id", corrected_value: "hacked" },
    ]);
    // The whitelist gate means nothing changes (and the rows are returned as-is).
    expect(out[0]!.campaign_id).toBe("c1");
    expect(out).toBe(base);
  });

  it("ignores a correction whose row_id matches no row", () => {
    const out = applyPerfOverrides(base, [
      { row_id: "missing", field_name: "spend", corrected_value: 1 },
    ]);
    expect(out[0]!.spend).toBe(100);
    expect(out[1]!.spend).toBe(200);
  });

  it("applies multiple corrections across rows + fields", () => {
    const out = applyPerfOverrides(base, [
      { row_id: "r1", field_name: "spend", corrected_value: 111 },
      { row_id: "r1", field_name: "leads_ghl", corrected_value: 7 },
      { row_id: "r2", field_name: "ctr", corrected_value: 0.05 },
    ]);
    expect(out[0]!.spend).toBe(111);
    expect(out[0]!.leads_ghl).toBe(7);
    expect(out[1]!.ctr).toBe(0.05);
  });
});
