/**
 * Tests for `app/api/creatives/archived/route.ts` (GET unified archived rows).
 * M4 / #593.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const buildSpy = vi.fn();
vi.mock("@/lib/creatives-rows", () => ({
  buildCreativeRows: (...args: unknown[]) => buildSpy(...args),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({}),
}));

import { GET } from "./route";

describe("GET /api/creatives/archived", () => {
  beforeEach(() => {
    buildSpy.mockReset();
  });

  it("200 with the archived unified rows", async () => {
    buildSpy.mockResolvedValueOnce({ rows: [{ id: "c1", kind: "image" }], error: null });
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rows).toEqual([{ id: "c1", kind: "image" }]);
    // Always requests the archived set.
    expect(buildSpy).toHaveBeenCalledWith({}, { archived: true });
  });

  it("500 when the builder reports an error", async () => {
    buildSpy.mockResolvedValueOnce({ rows: [], error: "boom" });
    const res = await GET();
    expect(res.status).toBe(500);
  });
});
