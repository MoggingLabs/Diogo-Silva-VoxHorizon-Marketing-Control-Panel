/**
 * Tests for `app/api/pipelines/[id]/config/route.ts` (PATCH).
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { mockSupabaseClient, type SupabaseClientMock } from "@/tests/unit/helpers/supabase-mock";

let currentSupabase: SupabaseClientMock = mockSupabaseClient();

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => currentSupabase,
}));

import { PATCH } from "./route";

const id = "11111111-1111-4111-8111-111111111111";
const params = Promise.resolve({ id });

function req(url: string, init: RequestInit = {}): NextRequest {
  return new NextRequest(new Request(url, init));
}

const existingDraft = { notes: "old" };

describe("PATCH /api/pipelines/:id/config", () => {
  beforeEach(() => {
    currentSupabase = mockSupabaseClient();
  });

  it("merges a notes patch (200)", async () => {
    currentSupabase = mockSupabaseClient({
      pipelines: {
        select: {
          single: {
            data: {
              id,
              status: "configuration",
              config_draft: existingDraft,
              format_choice: "image",
            },
            error: null,
          },
        },
        update: { single: { data: { id, status: "configuration" }, error: null } },
      },
    });
    const res = await PATCH(
      req(`http://localhost/api/pipelines/${id}/config`, {
        method: "PATCH",
        body: JSON.stringify({ notes: "new" }),
      }),
      { params },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.config_draft.notes).toBe("new");
  });

  it("deletes a key when value=null", async () => {
    currentSupabase = mockSupabaseClient({
      pipelines: {
        select: {
          single: {
            data: {
              id,
              status: "configuration",
              config_draft: { notes: "old", image_payload: { foo: 1 } },
              format_choice: "image",
            },
            error: null,
          },
        },
        update: { single: { data: { id }, error: null } },
      },
    });
    const res = await PATCH(
      req(`http://localhost/api/pipelines/${id}/config`, {
        method: "PATCH",
        body: JSON.stringify({ image_payload: null }),
      }),
      { params },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.config_draft.image_payload).toBeUndefined();
  });

  it("accepts format_choice + client_id top-level passthroughs", async () => {
    currentSupabase = mockSupabaseClient({
      pipelines: {
        select: {
          single: {
            data: { id, status: "configuration", config_draft: {}, format_choice: "image" },
            error: null,
          },
        },
        update: { single: { data: { id }, error: null } },
      },
    });
    const res = await PATCH(
      req(`http://localhost/api/pipelines/${id}/config`, {
        method: "PATCH",
        body: JSON.stringify({
          format_choice: "video",
          client_id: "22222222-2222-4222-8222-222222222222",
        }),
      }),
      { params },
    );
    expect(res.status).toBe(200);
  });

  it("starts from empty object when config_draft is an array", async () => {
    currentSupabase = mockSupabaseClient({
      pipelines: {
        select: {
          single: {
            data: { id, status: "configuration", config_draft: [], format_choice: "image" },
            error: null,
          },
        },
        update: { single: { data: { id }, error: null } },
      },
    });
    const res = await PATCH(
      req(`http://localhost/api/pipelines/${id}/config`, {
        method: "PATCH",
        body: JSON.stringify({ notes: "x" }),
      }),
      { params },
    );
    expect(res.status).toBe(200);
  });

  it("400 invalid JSON", async () => {
    const res = await PATCH(
      req(`http://localhost/api/pipelines/${id}/config`, { method: "PATCH", body: "{" }),
      { params },
    );
    expect(res.status).toBe(400);
  });

  it("400 empty body (zod refine)", async () => {
    const res = await PATCH(
      req(`http://localhost/api/pipelines/${id}/config`, {
        method: "PATCH",
        body: JSON.stringify({}),
      }),
      { params },
    );
    expect(res.status).toBe(400);
  });

  it("500 on read error", async () => {
    currentSupabase = mockSupabaseClient({
      pipelines: { select: { single: { data: null, error: { message: "x" } } } },
    });
    const res = await PATCH(
      req(`http://localhost/api/pipelines/${id}/config`, {
        method: "PATCH",
        body: JSON.stringify({ notes: "x" }),
      }),
      { params },
    );
    expect(res.status).toBe(500);
  });

  it("404 missing", async () => {
    currentSupabase = mockSupabaseClient({
      pipelines: { select: { single: { data: null, error: null } } },
    });
    const res = await PATCH(
      req(`http://localhost/api/pipelines/${id}/config`, {
        method: "PATCH",
        body: JSON.stringify({ notes: "x" }),
      }),
      { params },
    );
    expect(res.status).toBe(404);
  });

  it("409 when not in configuration", async () => {
    currentSupabase = mockSupabaseClient({
      pipelines: {
        select: {
          single: {
            data: { id, status: "review", config_draft: {}, format_choice: "image" },
            error: null,
          },
        },
      },
    });
    const res = await PATCH(
      req(`http://localhost/api/pipelines/${id}/config`, {
        method: "PATCH",
        body: JSON.stringify({ notes: "x" }),
      }),
      { params },
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("config locked");
  });

  it("500 when update fails", async () => {
    currentSupabase = mockSupabaseClient({
      pipelines: {
        select: {
          single: {
            data: { id, status: "configuration", config_draft: {}, format_choice: "image" },
            error: null,
          },
        },
        update: { single: { data: null, error: { message: "race" } } },
      },
    });
    const res = await PATCH(
      req(`http://localhost/api/pipelines/${id}/config`, {
        method: "PATCH",
        body: JSON.stringify({ notes: "x" }),
      }),
      { params },
    );
    expect(res.status).toBe(500);
  });
});
