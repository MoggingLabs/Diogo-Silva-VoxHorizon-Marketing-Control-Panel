/**
 * Tests for `app/api/launches/video/[id]/decision/route.ts`.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { mockSupabaseClient, type SupabaseClientMock } from "@/tests/unit/helpers/supabase-mock";

let currentSupabase: SupabaseClientMock = mockSupabaseClient();

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => currentSupabase,
}));

import { POST } from "./route";

const id = "11111111-1111-4111-8111-111111111111";
const params = Promise.resolve({ id });

function req(url: string, init: RequestInit = {}): NextRequest {
  return new NextRequest(new Request(url, init));
}

describe("POST /api/launches/video/:id/decision", () => {
  beforeEach(() => {
    currentSupabase = mockSupabaseClient();
  });

  it("approves a posted launch (200)", async () => {
    currentSupabase = mockSupabaseClient({
      video_launch_packages: {
        select: { single: { data: { id, status: "posted" }, error: null } },
        update: { single: { data: { id, status: "approved" }, error: null } },
      },
      events: { insert: { data: null, error: null } },
    });
    const res = await POST(
      req(`http://localhost/api/launches/video/${id}/decision`, {
        method: "POST",
        body: JSON.stringify({ decision: "approved" }),
      }),
      { params },
    );
    expect(res.status).toBe(200);
  });

  it("400 invalid JSON", async () => {
    const res = await POST(
      req(`http://localhost/api/launches/video/${id}/decision`, {
        method: "POST",
        body: "{",
      }),
      { params },
    );
    expect(res.status).toBe(400);
  });

  it("400 zod fail", async () => {
    const res = await POST(
      req(`http://localhost/api/launches/video/${id}/decision`, {
        method: "POST",
        body: JSON.stringify({ decision: "rejected" }),
      }),
      { params },
    );
    expect(res.status).toBe(400);
  });

  it("500 read error", async () => {
    currentSupabase = mockSupabaseClient({
      video_launch_packages: { select: { single: { data: null, error: { message: "x" } } } },
    });
    const res = await POST(
      req(`http://localhost/api/launches/video/${id}/decision`, {
        method: "POST",
        body: JSON.stringify({ decision: "approved" }),
      }),
      { params },
    );
    expect(res.status).toBe(500);
  });

  it("404 missing", async () => {
    currentSupabase = mockSupabaseClient({
      video_launch_packages: { select: { single: { data: null, error: null } } },
    });
    const res = await POST(
      req(`http://localhost/api/launches/video/${id}/decision`, {
        method: "POST",
        body: JSON.stringify({ decision: "approved" }),
      }),
      { params },
    );
    expect(res.status).toBe(404);
  });

  it("409 wrong state", async () => {
    currentSupabase = mockSupabaseClient({
      video_launch_packages: {
        select: { single: { data: { id, status: "approved" }, error: null } },
      },
    });
    const res = await POST(
      req(`http://localhost/api/launches/video/${id}/decision`, {
        method: "POST",
        body: JSON.stringify({ decision: "approved" }),
      }),
      { params },
    );
    expect(res.status).toBe(409);
  });

  it("500 update fail", async () => {
    currentSupabase = mockSupabaseClient({
      video_launch_packages: {
        select: { single: { data: { id, status: "posted" }, error: null } },
        update: { single: { data: null, error: { message: "no" } } },
      },
    });
    const res = await POST(
      req(`http://localhost/api/launches/video/${id}/decision`, {
        method: "POST",
        body: JSON.stringify({ decision: "approved" }),
      }),
      { params },
    );
    expect(res.status).toBe(500);
  });
});
