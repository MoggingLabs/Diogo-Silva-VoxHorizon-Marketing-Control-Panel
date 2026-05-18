/**
 * Tests for `app/api/pipelines/[id]/config/draft/route.ts` (SSE proxy).
 *
 * The route forwards to `chatStream` from `@/lib/hermes/client`, which
 * pulls `server-only`. Neutralise it before importing the route.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { mockClient } from "@/tests/unit/helpers/api-mock";
import { type SupabaseClientMock } from "@/tests/unit/helpers/supabase-mock";
import { sseResponse, stubFetchOnce } from "@/tests/unit/helpers/worker-mock";

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

const validBody = { messages: [{ role: "user", content: "hi" }] };

describe("POST /api/pipelines/:id/config/draft", () => {
  beforeEach(() => {
    currentSupabase = mockClient();
  });

  it("400 invalid JSON", async () => {
    const res = await POST(
      req(`http://localhost/api/pipelines/${id}/config/draft`, { method: "POST", body: "{" }),
      { params },
    );
    expect(res.status).toBe(400);
  });

  it("400 zod fail", async () => {
    const res = await POST(
      req(`http://localhost/api/pipelines/${id}/config/draft`, {
        method: "POST",
        body: JSON.stringify({ messages: [] }),
      }),
      { params },
    );
    expect(res.status).toBe(400);
  });

  it("500 fetch error", async () => {
    currentSupabase = mockClient({
      pipelines: { select: { single: { data: null, error: { message: "x" } } } },
    });
    const res = await POST(
      req(`http://localhost/api/pipelines/${id}/config/draft`, {
        method: "POST",
        body: JSON.stringify(validBody),
      }),
      { params },
    );
    expect(res.status).toBe(500);
  });

  it("404 missing", async () => {
    currentSupabase = mockClient({
      pipelines: { select: { single: { data: null, error: null } } },
    });
    const res = await POST(
      req(`http://localhost/api/pipelines/${id}/config/draft`, {
        method: "POST",
        body: JSON.stringify(validBody),
      }),
      { params },
    );
    expect(res.status).toBe(404);
  });

  it("409 when not in configuration", async () => {
    currentSupabase = mockClient({
      pipelines: {
        select: { single: { data: { id, status: "review", format_choice: "image" }, error: null } },
      },
    });
    const res = await POST(
      req(`http://localhost/api/pipelines/${id}/config/draft`, {
        method: "POST",
        body: JSON.stringify(validBody),
      }),
      { params },
    );
    expect(res.status).toBe(409);
  });

  it("502 worker unreachable", async () => {
    currentSupabase = mockClient({
      pipelines: {
        select: {
          single: {
            data: { id, status: "configuration", format_choice: "image" },
            error: null,
          },
        },
      },
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("ECONN");
    });
    const res = await POST(
      req(`http://localhost/api/pipelines/${id}/config/draft`, {
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
      pipelines: {
        select: {
          single: {
            data: { id, status: "configuration", format_choice: "image" },
            error: null,
          },
        },
      },
    });
    const fetchSpy = stubFetchOnce(new Response("oops", { status: 500 }));
    const res = await POST(
      req(`http://localhost/api/pipelines/${id}/config/draft`, {
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
      pipelines: {
        select: {
          single: {
            data: { id, status: "configuration", format_choice: "image" },
            error: null,
          },
        },
      },
    });
    const fetchSpy = stubFetchOnce(sseResponse([{ type: "message_stop" }]));
    const res = await POST(
      req(`http://localhost/api/pipelines/${id}/config/draft`, {
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
