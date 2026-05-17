/**
 * Tests for `app/api/creatives/video/[id]/broll/pick/route.ts`.
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

const validPick = {
  segment_idx: 0,
  store_backend: "local",
  clip_id: "clip-1",
  in_s: 0,
  out_s: 5,
  source_url: "https://example.com/clip.mp4",
};

describe("POST /api/creatives/video/:id/broll/pick", () => {
  beforeEach(() => {
    currentSupabase = mockSupabaseClient();
  });

  it("happy path persists picks (200)", async () => {
    currentSupabase = mockSupabaseClient({
      video_creatives: {
        select: { single: { data: { id, brief_id: "b1", broll_clips: [] }, error: null } },
        update: { single: { data: { id, broll_clips: [validPick] }, error: null } },
      },
      video_iterations: { insert: { data: null, error: null } },
      events: { insert: { data: null, error: null } },
    });
    const res = await POST(
      req(`http://localhost/api/creatives/video/${id}/broll/pick`, {
        method: "POST",
        body: JSON.stringify({ picks: [validPick] }),
      }),
      { params },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.creative).toBeTruthy();
  });

  it("400 invalid JSON", async () => {
    const res = await POST(
      req(`http://localhost/api/creatives/video/${id}/broll/pick`, {
        method: "POST",
        body: "{",
      }),
      { params },
    );
    expect(res.status).toBe(400);
  });

  it("400 zod failure (empty picks)", async () => {
    const res = await POST(
      req(`http://localhost/api/creatives/video/${id}/broll/pick`, {
        method: "POST",
        body: JSON.stringify({ picks: [] }),
      }),
      { params },
    );
    expect(res.status).toBe(400);
  });

  it("500 when read errors", async () => {
    currentSupabase = mockSupabaseClient({
      video_creatives: { select: { single: { data: null, error: { message: "x" } } } },
    });
    const res = await POST(
      req(`http://localhost/api/creatives/video/${id}/broll/pick`, {
        method: "POST",
        body: JSON.stringify({ picks: [validPick] }),
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
      req(`http://localhost/api/creatives/video/${id}/broll/pick`, {
        method: "POST",
        body: JSON.stringify({ picks: [validPick] }),
      }),
      { params },
    );
    expect(res.status).toBe(404);
  });

  it("500 when update fails", async () => {
    currentSupabase = mockSupabaseClient({
      video_creatives: {
        select: { single: { data: { id, brief_id: "b1" }, error: null } },
        update: { single: { data: null, error: { message: "no" } } },
      },
    });
    const res = await POST(
      req(`http://localhost/api/creatives/video/${id}/broll/pick`, {
        method: "POST",
        body: JSON.stringify({ picks: [validPick] }),
      }),
      { params },
    );
    expect(res.status).toBe(500);
  });

  it("warns when iteration insert fails (still 200)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    currentSupabase = mockSupabaseClient({
      video_creatives: {
        select: { single: { data: { id, brief_id: "b1" }, error: null } },
        update: { single: { data: { id }, error: null } },
      },
      video_iterations: { insert: { data: null, error: { message: "iter down" } } },
      events: { insert: { data: null, error: null } },
    });
    const res = await POST(
      req(`http://localhost/api/creatives/video/${id}/broll/pick`, {
        method: "POST",
        body: JSON.stringify({ picks: [validPick] }),
      }),
      { params },
    );
    expect(res.status).toBe(200);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("iter down"));
    warn.mockRestore();
  });

  it("warns when event insert fails (still 200)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    currentSupabase = mockSupabaseClient({
      video_creatives: {
        select: { single: { data: { id, brief_id: "b1" }, error: null } },
        update: { single: { data: { id }, error: null } },
      },
      video_iterations: { insert: { data: null, error: null } },
      events: { insert: { data: null, error: { message: "events down" } } },
    });
    const res = await POST(
      req(`http://localhost/api/creatives/video/${id}/broll/pick`, {
        method: "POST",
        body: JSON.stringify({ picks: [validPick] }),
      }),
      { params },
    );
    expect(res.status).toBe(200);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("events down"));
    warn.mockRestore();
  });
});
