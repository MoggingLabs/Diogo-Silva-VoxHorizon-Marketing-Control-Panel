/**
 * Tests for `app/api/creatives/[id]/chat/abort/route.ts`.
 *
 * The route forwards to `chatAbort` from `@/lib/hermes/client`, which
 * pulls `server-only`. Neutralise it for the jsdom run before the
 * route module is imported.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { mockClient } from "@/tests/unit/helpers/api-mock";
import { type SupabaseClientMock } from "@/tests/unit/helpers/supabase-mock";
import { jsonResponse, stubFetchOnce, stubFetchSequence } from "@/tests/unit/helpers/worker-mock";

let currentSupabase: SupabaseClientMock = mockClient();

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
    currentSupabase = mockClient();
  });

  it("flips the abort flag and returns 200", async () => {
    currentSupabase = mockClient({
      creatives: { select: { single: { data: { id }, error: null } } },
    });
    const fetchSpy = stubFetchOnce(jsonResponse({ aborted: true }));
    const res = await POST(
      req(`http://localhost/api/creatives/${id}/chat/abort`, { method: "POST" }),
      { params },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.aborted).toBe(true);
    fetchSpy.mockRestore();
  });

  it("returns 200 {aborted:false} when bridge replied 404 (no live session)", async () => {
    currentSupabase = mockClient({
      creatives: { select: { single: { data: { id }, error: null } } },
    });
    const fetchSpy = stubFetchOnce(new Response("not found", { status: 404 }));
    const res = await POST(
      req(`http://localhost/api/creatives/${id}/chat/abort`, { method: "POST" }),
      { params },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.aborted).toBe(false);
    fetchSpy.mockRestore();
  });

  it("500 when creative fetch errors", async () => {
    currentSupabase = mockClient({
      creatives: { select: { single: { data: null, error: { message: "down" } } } },
    });
    const res = await POST(
      req(`http://localhost/api/creatives/${id}/chat/abort`, { method: "POST" }),
      { params },
    );
    expect(res.status).toBe(500);
  });

  it("404 when creative missing", async () => {
    currentSupabase = mockClient({
      creatives: { select: { single: { data: null, error: null } } },
    });
    const res = await POST(
      req(`http://localhost/api/creatives/${id}/chat/abort`, { method: "POST" }),
      { params },
    );
    expect(res.status).toBe(404);
  });

  it("502 when worker returns non-2xx (after retry exhaustion)", async () => {
    currentSupabase = mockClient({
      creatives: { select: { single: { data: { id }, error: null } } },
    });
    // `chatAbort` goes through `callHermes`, which retries once on 5xx.
    // Stub two failing responses so the retry path is exercised too.
    const fetchSpy = stubFetchSequence([
      new Response("oops", { status: 500 }),
      new Response("oops again", { status: 500 }),
    ]);
    const res = await POST(
      req(`http://localhost/api/creatives/${id}/chat/abort`, { method: "POST" }),
      { params },
    );
    expect(res.status).toBe(502);
    fetchSpy.mockRestore();
  });

  it("502 when worker returns a non-retriable 4xx (e.g., 400)", async () => {
    currentSupabase = mockClient({
      creatives: { select: { single: { data: { id }, error: null } } },
    });
    const fetchSpy = stubFetchOnce(new Response("bad input", { status: 400 }));
    const res = await POST(
      req(`http://localhost/api/creatives/${id}/chat/abort`, { method: "POST" }),
      { params },
    );
    expect(res.status).toBe(502);
    fetchSpy.mockRestore();
  });

  it("502 when worker fetch throws", async () => {
    currentSupabase = mockClient({
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
