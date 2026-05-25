/**
 * Tests for `app/api/pipelines/[id]/route.ts` (GET + DELETE archive).
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

import { DELETE, GET } from "./route";

const id = "11111111-1111-4111-8111-111111111111";
const params = Promise.resolve({ id });

function req(url: string): NextRequest {
  return new NextRequest(new Request(url));
}

describe("GET /api/pipelines/:id", () => {
  beforeEach(() => {
    currentSupabase = mockClient();
  });

  it("200 with embedded resources", async () => {
    currentSupabase = mockClient({
      pipelines: {
        select: {
          single: {
            data: {
              id,
              status: "configuration",
              image_brief: { id: "ib1" },
              video_brief: { id: "vb1" },
              events: [{ id: "e1" }],
            },
            error: null,
          },
        },
      },
    });
    const res = await GET(req(`http://localhost/api/pipelines/${id}`), { params });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.pipeline.id).toBe(id);
    expect(body.image_brief).toEqual({ id: "ib1" });
    expect(body.video_brief).toEqual({ id: "vb1" });
    expect(body.events).toEqual([{ id: "e1" }]);
  });

  it("200 with defaulted nulls when embedded values absent", async () => {
    currentSupabase = mockClient({
      pipelines: {
        select: {
          single: {
            data: { id, status: "configuration" },
            error: null,
          },
        },
      },
    });
    const res = await GET(req(`http://localhost/api/pipelines/${id}`), { params });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.image_brief).toBeNull();
    expect(body.video_brief).toBeNull();
    expect(body.events).toEqual([]);
  });

  it("500 on error", async () => {
    currentSupabase = mockClient({
      pipelines: { select: { single: { data: null, error: { message: "x" } } } },
    });
    const res = await GET(req(`http://localhost/api/pipelines/${id}`), { params });
    expect(res.status).toBe(500);
  });

  it("404 when missing", async () => {
    currentSupabase = mockClient({
      pipelines: { select: { single: { data: null, error: null } } },
    });
    const res = await GET(req(`http://localhost/api/pipelines/${id}`), { params });
    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/pipelines/:id (archive)", () => {
  beforeEach(() => {
    currentSupabase = mockClient();
  });

  it("200 + sets deleted_at when archiving a live pipeline", async () => {
    currentSupabase = mockClient({
      pipelines: {
        // softDelete: update .. where deleted_at is null -> returns the row.
        update: {
          single: {
            data: { id, status: "ideation", deleted_at: "2026-05-25T00:00:00Z" },
            error: null,
          },
        },
      },
      events: { insert: { data: null, error: null } },
    });
    const res = await DELETE(req(`http://localhost/api/pipelines/${id}`), { params });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.pipeline.id).toBe(id);
    expect(body.pipeline.deleted_at).toBe("2026-05-25T00:00:00Z");
  });

  it("409 on double-archive (compare-and-set finds the row already archived)", async () => {
    currentSupabase = mockClient({
      pipelines: {
        // update matches nothing (already archived) ...
        update: { single: { data: null, error: null } },
        // ... and the disambiguation re-read finds the row -> conflict.
        select: { single: { data: { id, deleted_at: "2026-05-20T00:00:00Z" }, error: null } },
      },
    });
    const res = await DELETE(req(`http://localhost/api/pipelines/${id}`), { params });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("already_archived");
  });

  it("404 when the pipeline does not exist", async () => {
    currentSupabase = mockClient({
      pipelines: {
        update: { single: { data: null, error: null } },
        select: { single: { data: null, error: null } },
      },
    });
    const res = await DELETE(req(`http://localhost/api/pipelines/${id}`), { params });
    expect(res.status).toBe(404);
  });

  it("500 on a DB error during archive", async () => {
    currentSupabase = mockClient({
      pipelines: { update: { single: { data: null, error: { message: "boom" } } } },
    });
    const res = await DELETE(req(`http://localhost/api/pipelines/${id}`), { params });
    expect(res.status).toBe(500);
  });

  it("still 200 when the audit event insert fails (non-fatal)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    currentSupabase = mockClient({
      pipelines: {
        update: { single: { data: { id, deleted_at: "2026-05-25T00:00:00Z" }, error: null } },
      },
      events: { insert: { data: null, error: { message: "events down" } } },
    });
    const res = await DELETE(req(`http://localhost/api/pipelines/${id}`), { params });
    expect(res.status).toBe(200);
    warn.mockRestore();
  });
});
