/**
 * Tests for `app/api/creatives/video/[id]/chat/route.ts`.
 *
 * Same shape as the image-side chat-route test.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { mockClient } from "@/tests/unit/helpers/api-mock";
import { type SupabaseClientMock } from "@/tests/unit/helpers/supabase-mock";
import { sseResponse, stubFetchOnce } from "@/tests/unit/helpers/worker-mock";

let currentSupabase: SupabaseClientMock = mockClient();
const buildChatContextMock = vi.fn(async () => ({
  brief: { id: "b1", status: "approved", payload: {} },
  creative: {
    id: "c1",
    type: "video" as const,
    status: "draft",
    brief_id: "b1",
    created_at: "x",
    extra: {},
  },
  iterations: [],
  chat_history: [],
  available_tools: [],
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => currentSupabase,
}));
vi.mock("@/lib/chat-context", () => ({
  buildChatContext: (...args: Parameters<typeof buildChatContextMock>) =>
    buildChatContextMock(...args),
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

const validBody = { messages: [{ role: "user", content: "hi" }] };

describe("POST /api/creatives/video/:id/chat", () => {
  beforeEach(() => {
    currentSupabase = mockClient();
    buildChatContextMock.mockClear();
  });

  it("400 invalid JSON", async () => {
    const res = await POST(
      req(`http://localhost/api/creatives/video/${id}/chat`, { method: "POST", body: "{" }),
      { params },
    );
    expect(res.status).toBe(400);
  });

  it("400 empty messages", async () => {
    const res = await POST(
      req(`http://localhost/api/creatives/video/${id}/chat`, {
        method: "POST",
        body: JSON.stringify({ messages: [] }),
      }),
      { params },
    );
    expect(res.status).toBe(400);
  });

  it("500 when fetch errors", async () => {
    currentSupabase = mockClient({
      video_creatives: { select: { single: { data: null, error: { message: "x" } } } },
    });
    const res = await POST(
      req(`http://localhost/api/creatives/video/${id}/chat`, {
        method: "POST",
        body: JSON.stringify(validBody),
      }),
      { params },
    );
    expect(res.status).toBe(500);
  });

  it("404 when creative missing", async () => {
    currentSupabase = mockClient({
      video_creatives: { select: { single: { data: null, error: null } } },
    });
    const res = await POST(
      req(`http://localhost/api/creatives/video/${id}/chat`, {
        method: "POST",
        body: JSON.stringify(validBody),
      }),
      { params },
    );
    expect(res.status).toBe(404);
  });

  it("500 when buildChatContext throws", async () => {
    currentSupabase = mockClient({
      video_creatives: { select: { single: { data: { id, brief_id: "b1" }, error: null } } },
    });
    buildChatContextMock.mockRejectedValueOnce(new Error("brief missing"));
    const res = await POST(
      req(`http://localhost/api/creatives/video/${id}/chat`, {
        method: "POST",
        body: JSON.stringify(validBody),
      }),
      { params },
    );
    expect(res.status).toBe(500);
  });

  it("502 worker unreachable", async () => {
    currentSupabase = mockClient({
      video_creatives: { select: { single: { data: { id, brief_id: "b1" }, error: null } } },
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("ECONNREFUSED");
    });
    const res = await POST(
      req(`http://localhost/api/creatives/video/${id}/chat`, {
        method: "POST",
        body: JSON.stringify(validBody),
      }),
      { params },
    );
    expect(res.status).toBe(502);
    fetchSpy.mockRestore();
  });

  it("502 worker non-2xx", async () => {
    currentSupabase = mockClient({
      video_creatives: { select: { single: { data: { id, brief_id: "b1" }, error: null } } },
    });
    const fetchSpy = stubFetchOnce(new Response("oops", { status: 500 }));
    const res = await POST(
      req(`http://localhost/api/creatives/video/${id}/chat`, {
        method: "POST",
        body: JSON.stringify(validBody),
      }),
      { params },
    );
    expect(res.status).toBe(502);
    fetchSpy.mockRestore();
  });

  it("200 SSE passthrough", async () => {
    currentSupabase = mockClient({
      video_creatives: { select: { single: { data: { id, brief_id: "b1" }, error: null } } },
    });
    const fetchSpy = stubFetchOnce(sseResponse([{ type: "message_stop" }]));
    const res = await POST(
      req(`http://localhost/api/creatives/video/${id}/chat`, {
        method: "POST",
        body: JSON.stringify(validBody),
      }),
      { params },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    fetchSpy.mockRestore();
  });
});
