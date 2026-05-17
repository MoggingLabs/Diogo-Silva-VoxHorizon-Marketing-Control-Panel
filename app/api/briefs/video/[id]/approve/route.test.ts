/**
 * Tests for `app/api/briefs/video/[id]/approve/route.ts`.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { mockClient } from "@/tests/unit/helpers/api-mock";
import { type SupabaseClientMock } from "@/tests/unit/helpers/supabase-mock";

let currentSupabase: SupabaseClientMock = mockClient();

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => currentSupabase,
}));

import { POST } from "./route";

const id = "11111111-1111-4111-8111-111111111111";
const params = Promise.resolve({ id });

function req(url: string, init: RequestInit = {}): NextRequest {
  return new NextRequest(new Request(url, init));
}

describe("POST /api/briefs/video/:id/approve", () => {
  beforeEach(() => {
    currentSupabase = mockClient();
  });

  it("approves posted brief (200)", async () => {
    currentSupabase = mockClient({
      video_briefs: {
        select: { single: { data: { id, status: "posted" }, error: null } },
        update: { single: { data: { id, status: "approved" }, error: null } },
      },
      events: { insert: { data: null, error: null } },
    });

    const res = await POST(
      req(`http://localhost/api/briefs/video/${id}/approve`, {
        method: "POST",
        body: JSON.stringify({ decision: "approved" }),
      }),
      { params },
    );
    expect(res.status).toBe(200);
  });

  it("400 on invalid JSON", async () => {
    const res = await POST(
      req(`http://localhost/api/briefs/video/${id}/approve`, {
        method: "POST",
        body: "}",
      }),
      { params },
    );
    expect(res.status).toBe(400);
  });

  it("400 on missing notes for reject", async () => {
    const res = await POST(
      req(`http://localhost/api/briefs/video/${id}/approve`, {
        method: "POST",
        body: JSON.stringify({ decision: "rejected" }),
      }),
      { params },
    );
    expect(res.status).toBe(400);
  });

  it("500 on read error", async () => {
    currentSupabase = mockClient({
      video_briefs: { select: { single: { data: null, error: { message: "x" } } } },
    });
    const res = await POST(
      req(`http://localhost/api/briefs/video/${id}/approve`, {
        method: "POST",
        body: JSON.stringify({ decision: "approved" }),
      }),
      { params },
    );
    expect(res.status).toBe(500);
  });

  it("404 when missing", async () => {
    currentSupabase = mockClient({
      video_briefs: { select: { single: { data: null, error: null } } },
    });
    const res = await POST(
      req(`http://localhost/api/briefs/video/${id}/approve`, {
        method: "POST",
        body: JSON.stringify({ decision: "approved" }),
      }),
      { params },
    );
    expect(res.status).toBe(404);
  });

  it("409 when not posted", async () => {
    currentSupabase = mockClient({
      video_briefs: { select: { single: { data: { id, status: "draft" }, error: null } } },
    });
    const res = await POST(
      req(`http://localhost/api/briefs/video/${id}/approve`, {
        method: "POST",
        body: JSON.stringify({ decision: "approved" }),
      }),
      { params },
    );
    expect(res.status).toBe(409);
  });

  it("500 on update fail", async () => {
    currentSupabase = mockClient({
      video_briefs: {
        select: { single: { data: { id, status: "posted" }, error: null } },
        update: { single: { data: null, error: { message: "no" } } },
      },
    });
    const res = await POST(
      req(`http://localhost/api/briefs/video/${id}/approve`, {
        method: "POST",
        body: JSON.stringify({ decision: "approved" }),
      }),
      { params },
    );
    expect(res.status).toBe(500);
  });

  it("logs but returns 200 when event insert fails", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    currentSupabase = mockClient({
      video_briefs: {
        select: { single: { data: { id, status: "posted" }, error: null } },
        update: { single: { data: { id, status: "approved" }, error: null } },
      },
      events: { insert: { data: null, error: { message: "ev down" } } },
    });
    const res = await POST(
      req(`http://localhost/api/briefs/video/${id}/approve`, {
        method: "POST",
        body: JSON.stringify({ decision: "approved" }),
      }),
      { params },
    );
    expect(res.status).toBe(200);
    expect(err).toHaveBeenCalledWith(expect.stringContaining("ev down"));
    err.mockRestore();
  });
});
