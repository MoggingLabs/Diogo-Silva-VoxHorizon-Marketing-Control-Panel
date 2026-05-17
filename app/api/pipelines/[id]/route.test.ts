/**
 * Tests for `app/api/pipelines/[id]/route.ts` (GET).
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { mockClient } from "@/tests/unit/helpers/api-mock";
import { type SupabaseClientMock } from "@/tests/unit/helpers/supabase-mock";

let currentSupabase: SupabaseClientMock = mockClient();

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => currentSupabase,
}));

import { GET } from "./route";

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
