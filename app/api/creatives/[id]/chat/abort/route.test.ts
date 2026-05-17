/**
 * Tests for `app/api/creatives/[id]/chat/abort/route.ts`.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { mockSupabaseClient, type SupabaseClientMock } from "@/tests/unit/helpers/supabase-mock";
import { jsonResponse, stubFetchOnce } from "@/tests/unit/helpers/worker-mock";

let currentSupabase: SupabaseClientMock = mockSupabaseClient();

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => currentSupabase,
}));
vi.mock("@/lib/env", () => ({
  cleanEnv: (name: string) => {
    if (name === "WORKER_URL") return "http://worker.local";
    if (name === "WORKER_SHARED_SECRET") return "secret";
    return "";
  },
}));

import { POST } from "./route";

const id = "11111111-1111-4111-8111-111111111111";
const params = Promise.resolve({ id });

function req(url: string, init: RequestInit = {}): NextRequest {
  return new NextRequest(new Request(url, init));
}

describe("POST /api/creatives/:id/chat/abort", () => {
  beforeEach(() => {
    currentSupabase = mockSupabaseClient();
  });

  it("flips the abort flag and returns 200", async () => {
    currentSupabase = mockSupabaseClient({
      creatives: { select: { single: { data: { id }, error: null } } },
    });
    const fetchSpy = stubFetchOnce(jsonResponse({ ok: true }));
    const res = await POST(
      req(`http://localhost/api/creatives/${id}/chat/abort`, { method: "POST" }),
      { params },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.aborted).toBe(true);
    fetchSpy.mockRestore();
  });

  it("500 when creative fetch errors", async () => {
    currentSupabase = mockSupabaseClient({
      creatives: { select: { single: { data: null, error: { message: "down" } } } },
    });
    const res = await POST(
      req(`http://localhost/api/creatives/${id}/chat/abort`, { method: "POST" }),
      { params },
    );
    expect(res.status).toBe(500);
  });

  it("404 when creative missing", async () => {
    currentSupabase = mockSupabaseClient({
      creatives: { select: { single: { data: null, error: null } } },
    });
    const res = await POST(
      req(`http://localhost/api/creatives/${id}/chat/abort`, { method: "POST" }),
      { params },
    );
    expect(res.status).toBe(404);
  });

  it("502 when worker returns non-2xx", async () => {
    currentSupabase = mockSupabaseClient({
      creatives: { select: { single: { data: { id }, error: null } } },
    });
    const fetchSpy = stubFetchOnce(new Response("oops", { status: 500 }));
    const res = await POST(
      req(`http://localhost/api/creatives/${id}/chat/abort`, { method: "POST" }),
      { params },
    );
    expect(res.status).toBe(502);
    fetchSpy.mockRestore();
  });

  it("502 when worker fetch throws", async () => {
    currentSupabase = mockSupabaseClient({
      creatives: { select: { single: { data: { id }, error: null } } },
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("ECONNREFUSED");
    });
    const res = await POST(
      req(`http://localhost/api/creatives/${id}/chat/abort`, { method: "POST" }),
      { params },
    );
    expect(res.status).toBe(502);
    fetchSpy.mockRestore();
  });
});
