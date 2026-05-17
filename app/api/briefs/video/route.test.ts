/**
 * Tests for `app/api/briefs/video/route.ts` (POST + GET).
 *
 * The video route uses the cookie-bound server Supabase client, so we mock
 * `@/lib/supabase/server` instead of the admin client. The cookie wiring
 * inside `createClient` isn't exercised — the route only touches the
 * returned thenable chain.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { mockClient } from "@/tests/unit/helpers/api-mock";
import { type SupabaseClientMock } from "@/tests/unit/helpers/supabase-mock";

let currentSupabase: SupabaseClientMock = mockClient();

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => currentSupabase,
}));

import { GET, POST } from "./route";

function req(url: string, init: RequestInit = {}): NextRequest {
  return new NextRequest(new Request(url, init));
}

const validVideoBody = {
  client_id: "11111111-1111-4111-8111-111111111111",
  script_outline: {
    hook: "Discover the best roofing in Miami",
    segments: [{ topic: "Intro", duration_s: 30 }],
  },
  target_duration_s: 30,
  voice_id: "voice-1",
  dimensions: "9x16",
  broll_selection_mode: "review_each",
};

function withRpc(
  client: SupabaseClientMock,
  result: { data: unknown; error: { message: string } | null },
): SupabaseClientMock {
  (client as unknown as { rpc: ReturnType<typeof vi.fn> }).rpc = vi.fn(() =>
    Promise.resolve(result),
  );
  return client;
}

describe("POST /api/briefs/video", () => {
  beforeEach(() => {
    currentSupabase = mockClient();
  });

  it("creates a draft video brief (201)", async () => {
    currentSupabase = withRpc(
      mockClient({
        clients: {
          select: {
            single: { data: { id: "c1", slug: "acme" }, error: null },
          },
        },
        video_briefs: {
          insert: {
            single: {
              data: { id: "v1", brief_id_human: "ACME-V-0001", status: "draft" },
              error: null,
            },
          },
        },
        events: { insert: { data: null, error: null } },
      }),
      { data: "ACME-V-0001", error: null },
    );

    const res = await POST(
      req("http://localhost/api/briefs/video", {
        method: "POST",
        body: JSON.stringify(validVideoBody),
      }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toBe("v1");
  });

  it("posts immediately when ?post=1", async () => {
    currentSupabase = withRpc(
      mockClient({
        clients: {
          select: { single: { data: { id: "c1", slug: "acme" }, error: null } },
        },
        video_briefs: {
          insert: {
            single: {
              data: { id: "v2", brief_id_human: "ACME-V-0002", status: "posted" },
              error: null,
            },
          },
        },
        events: { insert: { data: null, error: null } },
      }),
      { data: "ACME-V-0002", error: null },
    );
    const res = await POST(
      req("http://localhost/api/briefs/video?post=1", {
        method: "POST",
        body: JSON.stringify(validVideoBody),
      }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.status).toBe("posted");
  });

  it("400 invalid JSON", async () => {
    const res = await POST(req("http://localhost/api/briefs/video", { method: "POST", body: "}" }));
    expect(res.status).toBe(400);
  });

  it("400 zod validation failure", async () => {
    const res = await POST(
      req("http://localhost/api/briefs/video", {
        method: "POST",
        body: JSON.stringify({ client_id: "not-uuid" }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("500 when clients read errors", async () => {
    currentSupabase = mockClient({
      clients: { select: { single: { data: null, error: { message: "bork" } } } },
    });
    const res = await POST(
      req("http://localhost/api/briefs/video", {
        method: "POST",
        body: JSON.stringify(validVideoBody),
      }),
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toMatch(/bork/);
  });

  it("404 when client missing", async () => {
    currentSupabase = mockClient({
      clients: { select: { single: { data: null, error: null } } },
    });
    const res = await POST(
      req("http://localhost/api/briefs/video", {
        method: "POST",
        body: JSON.stringify(validVideoBody),
      }),
    );
    expect(res.status).toBe(404);
  });

  it("500 when RPC fails", async () => {
    currentSupabase = withRpc(
      mockClient({
        clients: {
          select: { single: { data: { id: "c1", slug: "acme" }, error: null } },
        },
      }),
      { data: null, error: { message: "rpc dead" } },
    );
    const res = await POST(
      req("http://localhost/api/briefs/video", {
        method: "POST",
        body: JSON.stringify(validVideoBody),
      }),
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toMatch(/rpc dead/);
  });

  it("500 when video_briefs insert fails", async () => {
    currentSupabase = withRpc(
      mockClient({
        clients: {
          select: { single: { data: { id: "c1", slug: "acme" }, error: null } },
        },
        video_briefs: {
          insert: { single: { data: null, error: { message: "dup" } } },
        },
      }),
      { data: "ACME-V-0003", error: null },
    );
    const res = await POST(
      req("http://localhost/api/briefs/video", {
        method: "POST",
        body: JSON.stringify(validVideoBody),
      }),
    );
    expect(res.status).toBe(500);
  });

  it("returns 201 even when event insert fails (logs)", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    currentSupabase = withRpc(
      mockClient({
        clients: {
          select: { single: { data: { id: "c1", slug: "acme" }, error: null } },
        },
        video_briefs: {
          insert: {
            single: { data: { id: "v3", brief_id_human: "X", status: "draft" }, error: null },
          },
        },
        events: { insert: { data: null, error: { message: "events down" } } },
      }),
      { data: "X", error: null },
    );

    const res = await POST(
      req("http://localhost/api/briefs/video", {
        method: "POST",
        body: JSON.stringify(validVideoBody),
      }),
    );
    expect(res.status).toBe(201);
    expect(err).toHaveBeenCalledWith(expect.stringContaining("events down"));
    err.mockRestore();
  });
});

describe("GET /api/briefs/video", () => {
  beforeEach(() => {
    currentSupabase = mockClient();
  });

  it("returns list (200)", async () => {
    currentSupabase = mockClient({
      video_briefs: {
        select: { data: [{ id: "v1" }], error: null },
      },
    });
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(1);
  });

  it("returns 500 on supabase error", async () => {
    currentSupabase = mockClient({
      video_briefs: { select: { data: null, error: { message: "down" } } },
    });
    const res = await GET();
    expect(res.status).toBe(500);
  });
});
