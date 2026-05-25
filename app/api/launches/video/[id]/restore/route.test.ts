/**
 * Tests for `app/api/launches/video/[id]/restore/route.ts` (POST restore).
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

function req(): NextRequest {
  return new NextRequest(
    new Request(`http://localhost/api/launches/video/${id}/restore`, { method: "POST" }),
  );
}

describe("POST /api/launches/video/:id/restore", () => {
  beforeEach(() => {
    currentSupabase = mockClient();
  });

  it("200 + clears deleted_at", async () => {
    currentSupabase = mockClient({
      video_launch_packages: {
        update: { single: { data: { id, deleted_at: null }, error: null } },
      },
      events: { insert: { data: null, error: null } },
    });
    const res = await POST(req(), { params });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.launch.deleted_at).toBeNull();
  });

  it("409 when not archived", async () => {
    currentSupabase = mockClient({
      video_launch_packages: {
        update: { single: { data: null, error: null } },
        select: { single: { data: { id, deleted_at: null }, error: null } },
      },
    });
    const res = await POST(req(), { params });
    expect(res.status).toBe(409);
  });

  it("404 when missing", async () => {
    currentSupabase = mockClient({
      video_launch_packages: {
        update: { single: { data: null, error: null } },
        select: { single: { data: null, error: null } },
      },
    });
    const res = await POST(req(), { params });
    expect(res.status).toBe(404);
  });
});
