/**
 * Tests for `app/api/creatives/[id]/chat/route.ts` (SSE proxy).
 *
 * We mock `@/lib/supabase/admin`, `@/lib/chat-context`, and `@/lib/env` so we
 * can drive every code path (auth check, context build failure, worker
 * unreachable, worker non-2xx, happy-path SSE pass-through) without an
 * environment or live worker.
 *
 * The route imports `@/lib/hermes/client`, which in turn imports
 * `server-only`. That module errors when imported under jsdom (the env
 * this spec runs in) so we neutralise it the same way `lib/worker.test.ts`
 * does for the legacy worker client.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { mockClient } from "@/tests/unit/helpers/api-mock";
import { type SupabaseClientMock } from "@/tests/unit/helpers/supabase-mock";
import { sseResponse, stubFetchOnce } from "@/tests/unit/helpers/worker-mock";

let currentSupabase: SupabaseClientMock = mockClient();
const buildChatContextMock = vi.fn(async () => ({
  brief: { id: "b1", status: "approved", payload: {} },
  creative: {
    id: "c1",
    type: "image" as const,
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

describe("POST /api/creatives/:id/chat", () => {
  beforeEach(() => {
    currentSupabase = mockClient();
    buildChatContextMock.mockClear();
  });

  it("returns 400 on invalid JSON", async () => {
    const res = await POST(
      req(`http://localhost/api/creatives/${id}/chat`, { method: "POST", body: "{" }),
      { params },
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 on validation failure (empty messages)", async () => {
    const res = await POST(
      req(`http://localhost/api/creatives/${id}/chat`, {
        method: "POST",
        body: JSON.stringify({ messages: [] }),
      }),
      { params },
    );
    expect(res.status).toBe(400);
  });

  it("returns 500 when creative lookup errors", async () => {
    currentSupabase = mockClient({
      creatives: { select: { single: { data: null, error: { message: "down" } } } },
    });
    const res = await POST(
      req(`http://localhost/api/creatives/${id}/chat`, {
        method: "POST",
        body: JSON.stringify(validBody),
      }),
      { params },
    );
    expect(res.status).toBe(500);
  });

  it("returns 404 when creative missing", async () => {
    currentSupabase = mockClient({
      creatives: { select: { single: { data: null, error: null } } },
    });
    const res = await POST(
      req(`http://localhost/api/creatives/${id}/chat`, {
        method: "POST",
        body: JSON.stringify(validBody),
      }),
      { params },
    );
    expect(res.status).toBe(404);
  });

  it("returns 500 on chat-context build failure", async () => {
    currentSupabase = mockClient({
      creatives: { select: { single: { data: { id, brief_id: "b1" }, error: null } } },
    });
    buildChatContextMock.mockRejectedValueOnce(new Error("brief missing"));
    const res = await POST(
      req(`http://localhost/api/creatives/${id}/chat`, {
        method: "POST",
        body: JSON.stringify(validBody),
      }),
      { params },
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("context_build_failed");
  });

  it("returns 502 when worker fetch throws", async () => {
    currentSupabase = mockClient({
      creatives: { select: { single: { data: { id, brief_id: "b1" }, error: null } } },
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("ECONNREFUSED");
    });
    const res = await POST(
      req(`http://localhost/api/creatives/${id}/chat`, {
        method: "POST",
        body: JSON.stringify(validBody),
      }),
      { params },
    );
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBe("worker_unreachable");
    fetchSpy.mockRestore();
  });

  it("returns 502 when worker returns non-2xx", async () => {
    currentSupabase = mockClient({
      creatives: { select: { single: { data: { id, brief_id: "b1" }, error: null } } },
    });
    const fetchSpy = stubFetchOnce(new Response("oops", { status: 500 }));
    const res = await POST(
      req(`http://localhost/api/creatives/${id}/chat`, {
        method: "POST",
        body: JSON.stringify(validBody),
      }),
      { params },
    );
    expect(res.status).toBe(502);
    fetchSpy.mockRestore();
  });

  it("returns 200 with SSE pass-through on happy path", async () => {
    currentSupabase = mockClient({
      creatives: { select: { single: { data: { id, brief_id: "b1" }, error: null } } },
    });
    const fetchSpy = stubFetchOnce(sseResponse([{ type: "message_stop" }]));
    const res = await POST(
      req(`http://localhost/api/creatives/${id}/chat`, {
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
