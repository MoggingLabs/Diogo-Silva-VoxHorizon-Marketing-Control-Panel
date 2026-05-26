/**
 * Tests for `lib/ad-entity.ts` getAdEntitiesForLaunch (read-only loader).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { mockClient } from "@/tests/unit/helpers/api-mock";
import { type SupabaseClientMock } from "@/tests/unit/helpers/supabase-mock";

let currentSupabase: SupabaseClientMock = mockClient();

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => currentSupabase,
}));

import { getAdEntitiesForLaunch } from "./ad-entity";

describe("getAdEntitiesForLaunch", () => {
  beforeEach(() => {
    currentSupabase = mockClient();
  });

  it("returns the recorded entities for a launch", async () => {
    currentSupabase = mockClient({
      ad_entity: {
        select: { data: [{ id: "e1", kind: "campaign", meta_id: "123" }], error: null },
      },
    });
    const rows = await getAdEntitiesForLaunch("l1");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.meta_id).toBe("123");
  });

  it("returns [] when there are no entities", async () => {
    currentSupabase = mockClient({
      ad_entity: { select: { data: null, error: null } },
    });
    expect(await getAdEntitiesForLaunch("l1")).toEqual([]);
  });
});
