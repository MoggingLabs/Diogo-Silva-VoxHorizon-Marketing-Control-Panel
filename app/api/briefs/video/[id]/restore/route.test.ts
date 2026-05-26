/**
 * Tests for `app/api/briefs/video/[id]/restore/route.ts` (POST restore).
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
    new Request(`http://localhost/api/briefs/video/${id}/restore`, { method: "POST" }),
  );
}

describe("POST /api/briefs/video/:id/restore", () => {
  beforeEach(() => {
    currentSupabase = mockClient();
  });

  it("200 + clears deleted_at when restoring an archived video brief", async () => {
    currentSupabase = mockClient({
      video_briefs: {
        update: { single: { data: { id, status: "draft", deleted_at: null }, error: null } },
      },
      events: { insert: { data: null, error: null } },
    });
    const res = await POST(req(), { params });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(id);
    expect(body.deleted_at).toBeNull();
  });

  it("409 when not archived", async () => {
    currentSupabase = mockClient({
      video_briefs: {
        update: { single: { data: null, error: null } },
        select: { single: { data: { id, deleted_at: null }, error: null } },
      },
    });
    const res = await POST(req(), { params });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("not_archived");
  });

  it("404 when missing", async () => {
    currentSupabase = mockClient({
      video_briefs: {
        update: { single: { data: null, error: null } },
        select: { single: { data: null, error: null } },
      },
    });
    const res = await POST(req(), { params });
    expect(res.status).toBe(404);
  });

  it("500 on a DB error during restore", async () => {
    currentSupabase = mockClient({
      video_briefs: { update: { single: { data: null, error: { message: "nope" } } } },
    });
    const res = await POST(req(), { params });
    expect(res.status).toBe(500);
  });
});
