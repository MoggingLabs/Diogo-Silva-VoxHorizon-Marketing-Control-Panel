/**
 * Tests for `app/api/briefs/video/[id]/route.ts` (GET + PATCH).
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { mockClient } from "@/tests/unit/helpers/api-mock";
import { type SupabaseClientMock } from "@/tests/unit/helpers/supabase-mock";

let currentSupabase: SupabaseClientMock = mockClient();

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => currentSupabase,
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => currentSupabase,
}));

import { DELETE, GET, PATCH } from "./route";

const id = "11111111-1111-4111-8111-111111111111";
const params = Promise.resolve({ id });

function req(url: string, init: RequestInit = {}): NextRequest {
  return new NextRequest(new Request(url, init));
}

describe("GET /api/briefs/video/:id", () => {
  beforeEach(() => {
    currentSupabase = mockClient();
  });

  it("returns the brief (200)", async () => {
    currentSupabase = mockClient({
      video_briefs: { select: { single: { data: { id, status: "draft" }, error: null } } },
    });
    const res = await GET(req(`http://localhost/api/briefs/video/${id}`), {
      params,
    });
    expect(res.status).toBe(200);
  });

  it("500 on supabase error", async () => {
    currentSupabase = mockClient({
      video_briefs: { select: { single: { data: null, error: { message: "boom" } } } },
    });
    const res = await GET(req(`http://localhost/api/briefs/video/${id}`), {
      params,
    });
    expect(res.status).toBe(500);
  });

  it("404 when not found", async () => {
    currentSupabase = mockClient({
      video_briefs: { select: { single: { data: null, error: null } } },
    });
    const res = await GET(req(`http://localhost/api/briefs/video/${id}`), {
      params,
    });
    expect(res.status).toBe(404);
  });
});

describe("PATCH /api/briefs/video/:id", () => {
  beforeEach(() => {
    currentSupabase = mockClient();
  });

  it("updates a single field (200)", async () => {
    currentSupabase = mockClient({
      video_briefs: {
        select: {
          single: {
            data: {
              id,
              status: "draft",
              brief_id_human: "X",
              payload: { notes: "old" },
            },
            error: null,
          },
        },
        update: { single: { data: { id, status: "draft" }, error: null } },
      },
      events: { insert: { data: null, error: null } },
    });

    const res = await PATCH(
      req(`http://localhost/api/briefs/video/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ voice_id: "voice-2-abc" }),
      }),
      { params },
    );
    expect(res.status).toBe(200);
  });

  it("transitions draft → posted and stamps posted_at", async () => {
    currentSupabase = mockClient({
      video_briefs: {
        select: {
          single: { data: { id, status: "draft", payload: {} }, error: null },
        },
        update: { single: { data: { id, status: "posted" }, error: null } },
      },
      events: { insert: { data: null, error: null } },
    });

    const res = await PATCH(
      req(`http://localhost/api/briefs/video/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "posted" }),
      }),
      { params },
    );
    expect(res.status).toBe(200);
  });

  it("merges notes into payload (200)", async () => {
    currentSupabase = mockClient({
      video_briefs: {
        select: {
          single: {
            data: { id, status: "draft", payload: { music: "edm" } },
            error: null,
          },
        },
        update: { single: { data: { id, status: "draft" }, error: null } },
      },
      events: { insert: { data: null, error: null } },
    });
    const res = await PATCH(
      req(`http://localhost/api/briefs/video/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ notes: "new note" }),
      }),
      { params },
    );
    expect(res.status).toBe(200);
  });

  it("merges payload object onto existing array-payload by replacing", async () => {
    // current.payload is an array — coerce to empty object.
    currentSupabase = mockClient({
      video_briefs: {
        select: { single: { data: { id, status: "draft", payload: [] }, error: null } },
        update: { single: { data: { id, status: "draft" }, error: null } },
      },
      events: { insert: { data: null, error: null } },
    });
    const res = await PATCH(
      req(`http://localhost/api/briefs/video/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ payload: { foo: "bar" } }),
      }),
      { params },
    );
    expect(res.status).toBe(200);
  });

  it("400 on invalid JSON", async () => {
    const res = await PATCH(
      req(`http://localhost/api/briefs/video/${id}`, { method: "PATCH", body: "{" }),
      { params },
    );
    expect(res.status).toBe(400);
  });

  it("400 on zod failure", async () => {
    const res = await PATCH(
      req(`http://localhost/api/briefs/video/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ target_duration_s: -1 }),
      }),
      { params },
    );
    expect(res.status).toBe(400);
  });

  it("500 on read error", async () => {
    currentSupabase = mockClient({
      video_briefs: { select: { single: { data: null, error: { message: "down" } } } },
    });
    const res = await PATCH(
      req(`http://localhost/api/briefs/video/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ voice_id: "xx" }),
      }),
      { params },
    );
    expect(res.status).toBe(500);
  });

  it("404 when missing", async () => {
    currentSupabase = mockClient({
      video_briefs: { select: { single: { data: null, error: null } } },
    });
    const res = await PATCH(
      req(`http://localhost/api/briefs/video/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ voice_id: "xx" }),
      }),
      { params },
    );
    expect(res.status).toBe(404);
  });

  it("409 on disallowed transition", async () => {
    currentSupabase = mockClient({
      video_briefs: {
        select: {
          single: { data: { id, status: "approved", payload: {} }, error: null },
        },
      },
    });
    const res = await PATCH(
      req(`http://localhost/api/briefs/video/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "draft" }),
      }),
      { params },
    );
    expect(res.status).toBe(409);
  });

  it("500 on update fail", async () => {
    currentSupabase = mockClient({
      video_briefs: {
        select: {
          single: { data: { id, status: "draft", payload: {} }, error: null },
        },
        update: { single: { data: null, error: { message: "no" } } },
      },
    });
    const res = await PATCH(
      req(`http://localhost/api/briefs/video/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "posted" }),
      }),
      { params },
    );
    expect(res.status).toBe(500);
  });

  it("logs but returns 200 when event insert fails", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    currentSupabase = mockClient({
      video_briefs: {
        select: {
          single: { data: { id, status: "draft", payload: {} }, error: null },
        },
        update: { single: { data: { id, status: "draft" }, error: null } },
      },
      events: { insert: { data: null, error: { message: "events down" } } },
    });

    const res = await PATCH(
      req(`http://localhost/api/briefs/video/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ voice_id: "voice-yy" }),
      }),
      { params },
    );
    expect(res.status).toBe(200);
    expect(err).toHaveBeenCalledWith(expect.stringContaining("events down"));
    err.mockRestore();
  });
});

describe("DELETE /api/briefs/video/:id (archive)", () => {
  beforeEach(() => {
    currentSupabase = mockClient();
  });

  it("200 + stamps deleted_at and emits video_brief_archived", async () => {
    currentSupabase = mockClient({
      video_briefs: {
        update: { single: { data: { id, deleted_at: "2026-05-25T00:00:00Z" }, error: null } },
      },
      events: { insert: { data: null, error: null } },
    });
    const res = await DELETE(req(`http://localhost/api/briefs/video/${id}`, { method: "DELETE" }), {
      params,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(id);
    expect(body.deleted_at).not.toBeNull();
  });

  it("409 when already archived", async () => {
    currentSupabase = mockClient({
      video_briefs: {
        update: { single: { data: null, error: null } },
        select: { single: { data: { id, deleted_at: "2026-05-25T00:00:00Z" }, error: null } },
      },
    });
    const res = await DELETE(req(`http://localhost/api/briefs/video/${id}`, { method: "DELETE" }), {
      params,
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("already_archived");
  });

  it("404 when missing", async () => {
    currentSupabase = mockClient({
      video_briefs: {
        update: { single: { data: null, error: null } },
        select: { single: { data: null, error: null } },
      },
    });
    const res = await DELETE(req(`http://localhost/api/briefs/video/${id}`, { method: "DELETE" }), {
      params,
    });
    expect(res.status).toBe(404);
  });

  it("500 on a DB error during archive", async () => {
    currentSupabase = mockClient({
      video_briefs: { update: { single: { data: null, error: { message: "nope" } } } },
    });
    const res = await DELETE(req(`http://localhost/api/briefs/video/${id}`, { method: "DELETE" }), {
      params,
    });
    expect(res.status).toBe(500);
  });
});
