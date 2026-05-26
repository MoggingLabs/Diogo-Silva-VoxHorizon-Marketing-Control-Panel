/**
 * Tests for `app/api/creatives/video/[id]/route.ts` (GET + PATCH metadata +
 * DELETE archive). M4 / #594.
 *
 * Guardrail coverage: PATCH never writes `status` (the video pipeline status
 * flows through the decision route) and only forwards the whitelisted
 * `asset_name` field. Archive is a soft-delete (compare-and-set).
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { mockClient } from "@/tests/unit/helpers/api-mock";
import { type SupabaseClientMock } from "@/tests/unit/helpers/supabase-mock";

let currentSupabase: SupabaseClientMock = mockClient();

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => currentSupabase,
}));

import { DELETE, GET, PATCH } from "./route";

const id = "22222222-2222-4222-8222-222222222222";
const params = Promise.resolve({ id });

function req(method: string, body?: unknown): NextRequest {
  return new NextRequest(
    new Request(`http://localhost/api/creatives/video/${id}`, {
      method,
      ...(body !== undefined
        ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
        : {}),
    }),
  );
}

describe("GET /api/creatives/video/:id", () => {
  beforeEach(() => {
    currentSupabase = mockClient();
  });

  it("200 with creative + brief + copy_variants + events", async () => {
    currentSupabase = mockClient({
      video_creatives: {
        select: { single: { data: { id, brief_id: "vb1", status: "captioned" }, error: null } },
      },
      video_briefs: {
        select: {
          single: { data: { id: "vb1", brief_id_human: "vbr-1", status: "approved" }, error: null },
        },
      },
      video_copy_variants: { select: { data: [{ id: "vcv1" }], error: null } },
      events: { select: { data: [{ id: "e1", kind: "video_creative_decided" }], error: null } },
    });
    const res = await GET(req("GET"), { params });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.creative.id).toBe(id);
    expect(body.brief.brief_id_human).toBe("vbr-1");
    expect(body.copy_variants).toEqual([{ id: "vcv1" }]);
  });

  it("404 when the video creative is missing", async () => {
    currentSupabase = mockClient({
      video_creatives: { select: { single: { data: null, error: null } } },
    });
    const res = await GET(req("GET"), { params });
    expect(res.status).toBe(404);
  });

  it("500 on a DB error reading the creative", async () => {
    currentSupabase = mockClient({
      video_creatives: { select: { single: { data: null, error: { message: "boom" } } } },
    });
    const res = await GET(req("GET"), { params });
    expect(res.status).toBe(500);
  });
});

describe("PATCH /api/creatives/video/:id", () => {
  beforeEach(() => {
    currentSupabase = mockClient();
  });

  it("200 edits asset_name", async () => {
    currentSupabase = mockClient({
      video_creatives: {
        update: { single: { data: { id, asset_name: "Hero cut" }, error: null } },
      },
      events: { insert: { data: null, error: null } },
    });
    const res = await PATCH(req("PATCH", { asset_name: "Hero cut" }), { params });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.creative.asset_name).toBe("Hero cut");
  });

  it("guardrail: never writes a smuggled status key", async () => {
    const updateSpy = vi.fn();
    currentSupabase = mockClient({
      video_creatives: { update: { single: { data: { id, asset_name: "a" }, error: null } } },
      events: { insert: { data: null, error: null } },
    });
    const realFrom = currentSupabase.from;
    currentSupabase.from = vi.fn((table: string) => {
      const builder = realFrom(table) as Record<string, unknown>;
      if (table === "video_creatives") {
        const realUpdate = builder.update as (...a: unknown[]) => unknown;
        builder.update = vi.fn((payload: unknown) => {
          updateSpy(payload);
          return realUpdate(payload);
        });
      }
      return builder as never;
    }) as never;

    const res = await PATCH(req("PATCH", { asset_name: "a", status: "approved" }), { params });
    expect(res.status).toBe(200);
    const payload = updateSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload).not.toHaveProperty("status");
    expect(payload).toHaveProperty("asset_name", "a");
  });

  it("400 when no editable key present", async () => {
    const res = await PATCH(req("PATCH", { status: "approved" }), { params });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("nothing to update");
  });

  it("400 on invalid JSON", async () => {
    const bad = new NextRequest(
      new Request(`http://localhost/api/creatives/video/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: "{nope",
      }),
    );
    const res = await PATCH(bad, { params });
    expect(res.status).toBe(400);
  });

  it("404 when the row is missing / already archived", async () => {
    currentSupabase = mockClient({
      video_creatives: { update: { single: { data: null, error: null } } },
    });
    const res = await PATCH(req("PATCH", { asset_name: "x" }), { params });
    expect(res.status).toBe(404);
  });

  it("500 on a DB error during update", async () => {
    currentSupabase = mockClient({
      video_creatives: { update: { single: { data: null, error: { message: "db" } } } },
    });
    const res = await PATCH(req("PATCH", { asset_name: "x" }), { params });
    expect(res.status).toBe(500);
  });
});

describe("DELETE /api/creatives/video/:id (archive)", () => {
  beforeEach(() => {
    currentSupabase = mockClient();
  });

  it("200 soft-deletes and stamps deleted_at", async () => {
    currentSupabase = mockClient({
      video_creatives: {
        update: { single: { data: { id, deleted_at: "2026-01-01T00:00:00Z" }, error: null } },
      },
      events: { insert: { data: null, error: null } },
    });
    const res = await DELETE(req("DELETE"), { params });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.creative.deleted_at).toBe("2026-01-01T00:00:00Z");
  });

  it("409 when already archived", async () => {
    currentSupabase = mockClient({
      video_creatives: {
        update: { single: { data: null, error: null } },
        select: { single: { data: { id, deleted_at: "2026-01-01T00:00:00Z" }, error: null } },
      },
    });
    const res = await DELETE(req("DELETE"), { params });
    expect(res.status).toBe(409);
  });

  it("404 when the creative does not exist", async () => {
    currentSupabase = mockClient({
      video_creatives: {
        update: { single: { data: null, error: null } },
        select: { single: { data: null, error: null } },
      },
    });
    const res = await DELETE(req("DELETE"), { params });
    expect(res.status).toBe(404);
  });

  it("500 on a DB error during archive", async () => {
    currentSupabase = mockClient({
      video_creatives: { update: { single: { data: null, error: { message: "nope" } } } },
    });
    const res = await DELETE(req("DELETE"), { params });
    expect(res.status).toBe(500);
  });
});
