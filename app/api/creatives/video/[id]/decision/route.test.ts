/**
 * Tests for `app/api/creatives/video/[id]/decision/route.ts`.
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

describe("POST /api/creatives/video/:id/decision", () => {
  beforeEach(() => {
    currentSupabase = mockSupabaseClient();
  });

  it("approves a captioned video (200)", async () => {
    currentSupabase = mockSupabaseClient({
      video_creatives: {
        select: { single: { data: { id, status: "captioned" }, error: null } },
        update: { single: { data: { id, status: "approved" }, error: null } },
      },
      events: { insert: { data: null, error: null } },
    });
    const res = await POST(
      req(`http://localhost/api/creatives/video/${id}/decision`, {
        method: "POST",
        body: JSON.stringify({ decision: "approve" }),
      }),
      { params },
    );
    expect(res.status).toBe(200);
  });

  it("rejects from draft (200)", async () => {
    currentSupabase = mockSupabaseClient({
      video_creatives: {
        select: { single: { data: { id, status: "draft" }, error: null } },
        update: { single: { data: { id, status: "rejected" }, error: null } },
      },
      events: { insert: { data: null, error: null } },
    });
    const res = await POST(
      req(`http://localhost/api/creatives/video/${id}/decision`, {
        method: "POST",
        body: JSON.stringify({ decision: "reject" }),
      }),
      { params },
    );
    expect(res.status).toBe(200);
  });

  it("400 invalid JSON", async () => {
    const res = await POST(
      req(`http://localhost/api/creatives/video/${id}/decision`, {
        method: "POST",
        body: "{",
      }),
      { params },
    );
    expect(res.status).toBe(400);
  });

  it("400 invalid decision", async () => {
    const res = await POST(
      req(`http://localhost/api/creatives/video/${id}/decision`, {
        method: "POST",
        body: JSON.stringify({ decision: "halt" }),
      }),
      { params },
    );
    expect(res.status).toBe(400);
  });

  it("500 on fetch error", async () => {
    currentSupabase = mockSupabaseClient({
      video_creatives: { select: { single: { data: null, error: { message: "x" } } } },
    });
    const res = await POST(
      req(`http://localhost/api/creatives/video/${id}/decision`, {
        method: "POST",
        body: JSON.stringify({ decision: "approve" }),
      }),
      { params },
    );
    expect(res.status).toBe(500);
  });

  it("404 when missing", async () => {
    currentSupabase = mockSupabaseClient({
      video_creatives: { select: { single: { data: null, error: null } } },
    });
    const res = await POST(
      req(`http://localhost/api/creatives/video/${id}/decision`, {
        method: "POST",
        body: JSON.stringify({ decision: "approve" }),
      }),
      { params },
    );
    expect(res.status).toBe(404);
  });

  it("409 when approving from non-captioned", async () => {
    currentSupabase = mockSupabaseClient({
      video_creatives: { select: { single: { data: { id, status: "draft" }, error: null } } },
    });
    const res = await POST(
      req(`http://localhost/api/creatives/video/${id}/decision`, {
        method: "POST",
        body: JSON.stringify({ decision: "approve" }),
      }),
      { params },
    );
    expect(res.status).toBe(409);
  });

  it("500 when update fails", async () => {
    currentSupabase = mockSupabaseClient({
      video_creatives: {
        select: { single: { data: { id, status: "captioned" }, error: null } },
        update: { single: { data: null, error: { message: "nope" } } },
      },
    });
    const res = await POST(
      req(`http://localhost/api/creatives/video/${id}/decision`, {
        method: "POST",
        body: JSON.stringify({ decision: "approve" }),
      }),
      { params },
    );
    expect(res.status).toBe(500);
  });

  it("warns but returns 200 when event insert fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    currentSupabase = mockSupabaseClient({
      video_creatives: {
        select: { single: { data: { id, status: "captioned" }, error: null } },
        update: { single: { data: { id, status: "approved" }, error: null } },
      },
      events: { insert: { data: null, error: { message: "events down" } } },
    });
    const res = await POST(
      req(`http://localhost/api/creatives/video/${id}/decision`, {
        method: "POST",
        body: JSON.stringify({ decision: "approve" }),
      }),
      { params },
    );
    expect(res.status).toBe(200);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("events down"));
    warn.mockRestore();
  });
});
