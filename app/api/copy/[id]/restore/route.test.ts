/**
 * Tests for `app/api/copy/[id]/restore/route.ts` (standalone copy POST restore).
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

const id = "33333333-3333-4333-8333-333333333333";
const params = Promise.resolve({ id });

function req(format = "image"): NextRequest {
  return new NextRequest(
    new Request(`http://localhost/api/copy/${id}/restore?format=${format}`, { method: "POST" }),
  );
}

describe("POST /api/copy/:id/restore", () => {
  beforeEach(() => {
    currentSupabase = mockClient();
  });

  it("200 restores an archived image variant", async () => {
    currentSupabase = mockClient({
      copy_variants: { update: { single: { data: { id, deleted_at: null }, error: null } } },
      events: { insert: { data: null, error: null } },
    });
    const res = await POST(req("image"), { params });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.variant.deleted_at).toBeNull();
  });

  it("restores a video variant from the video table", async () => {
    currentSupabase = mockClient({
      video_copy_variants: { update: { single: { data: { id, deleted_at: null }, error: null } } },
      events: { insert: { data: null, error: null } },
    });
    const res = await POST(req("video"), { params });
    expect(res.status).toBe(200);
    expect(currentSupabase._spies.from).toHaveBeenCalledWith("video_copy_variants");
  });

  it("400 on a bad format", async () => {
    const res = await POST(req("audio"), { params });
    expect(res.status).toBe(400);
  });

  it("409 when not archived", async () => {
    currentSupabase = mockClient({
      copy_variants: {
        update: { single: { data: null, error: null } },
        select: { single: { data: { id, deleted_at: null }, error: null } },
      },
    });
    const res = await POST(req("image"), { params });
    expect(res.status).toBe(409);
  });

  it("404 when missing", async () => {
    currentSupabase = mockClient({
      copy_variants: {
        update: { single: { data: null, error: null } },
        select: { single: { data: null, error: null } },
      },
    });
    const res = await POST(req("image"), { params });
    expect(res.status).toBe(404);
  });
});
