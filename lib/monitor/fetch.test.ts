import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mockClient } from "@/tests/unit/helpers/api-mock";
import { type SupabaseClientMock } from "@/tests/unit/helpers/supabase-mock";

vi.mock("server-only", () => ({}));

let currentSupabase: SupabaseClientMock = mockClient();
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => currentSupabase,
}));

import { getMonitorRows } from "./fetch";

beforeEach(() => {
  currentSupabase = mockClient();
});
afterEach(() => vi.restoreAllMocks());

describe("getMonitorRows", () => {
  it("returns the perf rows for a pipeline", async () => {
    currentSupabase = mockClient({
      campaign_perf_image: {
        select: { data: [{ campaign_id: "c1", spend: 100, leads_ghl: 2, leads_meta: 3 }] },
      },
    });
    const rows = await getMonitorRows("p1");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.campaign_id).toBe("c1");
  });

  it("returns [] when there is no data", async () => {
    expect(await getMonitorRows("p1")).toEqual([]);
  });
});
