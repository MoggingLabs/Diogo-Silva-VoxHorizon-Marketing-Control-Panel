/**
 * Tests for `app/api/launches/video/[id]/route.ts` (GET).
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { mockClient } from "@/tests/unit/helpers/api-mock";
import { type SupabaseClientMock } from "@/tests/unit/helpers/supabase-mock";

let currentSupabase: SupabaseClientMock = mockClient();

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => currentSupabase,
}));

import { GET } from "./route";

const id = "11111111-1111-4111-8111-111111111111";
const params = Promise.resolve({ id });

function req(url: string): NextRequest {
  return new NextRequest(new Request(url));
}

describe("GET /api/launches/video/:id", () => {
  beforeEach(() => {
    currentSupabase = mockClient();
  });

  it("200 returns the launch", async () => {
    currentSupabase = mockClient({
      video_launch_packages: {
        select: { single: { data: { id, status: "posted" }, error: null } },
      },
    });
    const res = await GET(req(`http://localhost/api/launches/video/${id}`), { params });
    expect(res.status).toBe(200);
  });

  it("500 on error", async () => {
    currentSupabase = mockClient({
      video_launch_packages: { select: { single: { data: null, error: { message: "x" } } } },
    });
    const res = await GET(req(`http://localhost/api/launches/video/${id}`), { params });
    expect(res.status).toBe(500);
  });

  it("404 missing", async () => {
    currentSupabase = mockClient({
      video_launch_packages: { select: { single: { data: null, error: null } } },
    });
    const res = await GET(req(`http://localhost/api/launches/video/${id}`), { params });
    expect(res.status).toBe(404);
  });
});
