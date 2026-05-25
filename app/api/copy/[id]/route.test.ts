/**
 * Tests for `app/api/copy/[id]/route.ts` (standalone copy PATCH edit + DELETE
 * archive).
 *
 * Key guardrail: editing copy RE-ARMS COMPLIANCE. The PATCH must reset the row
 * to `draft` (and clear the image approval stamps) regardless of what changed,
 * so an approved variant cannot stay approved through a content edit.
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

import { DELETE, PATCH } from "./route";

const id = "33333333-3333-4333-8333-333333333333";
const params = Promise.resolve({ id });

function req(url: string, init: RequestInit = {}): NextRequest {
  return new NextRequest(new Request(url, init));
}

describe("PATCH /api/copy/:id (recompliance)", () => {
  beforeEach(() => {
    currentSupabase = mockClient();
  });

  it("resets an approved image variant to draft on edit + clears approval stamps", async () => {
    let capturedUpdate: Record<string, unknown> | null = null;
    currentSupabase = mockClient({
      copy_variants: {
        select: {
          single: {
            data: {
              id,
              status: "approved",
              platform: "meta",
              headline: "old",
              approved_by: "operator",
              approved_at: "2026-05-20T00:00:00Z",
            },
            error: null,
          },
        },
        update: { single: { data: { id, status: "draft" }, error: null } },
      },
      events: { insert: { data: null, error: null } },
    });
    // Capture the update payload to assert the recompliance reset.
    const realFrom = currentSupabase.from;
    currentSupabase.from = vi.fn((table: string) => {
      const builder = realFrom(table) as unknown as {
        update: (u: Record<string, unknown>) => unknown;
      };
      if (table === "copy_variants") {
        const realUpdate = builder.update.bind(builder);
        builder.update = (u: Record<string, unknown>) => {
          capturedUpdate = u;
          return realUpdate(u);
        };
      }
      return builder;
    }) as typeof currentSupabase.from;

    const res = await PATCH(
      req(`http://localhost/api/copy/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ format: "image", headline: "new headline" }),
      }),
      { params },
    );
    expect(res.status).toBe(200);
    expect(capturedUpdate).toMatchObject({
      status: "draft",
      approved_by: null,
      approved_at: null,
      headline: "new headline",
    });
  });

  it("resets a video variant to draft on edit (no approval-stamp columns)", async () => {
    currentSupabase = mockClient({
      video_copy_variants: {
        select: { single: { data: { id, status: "approved", platform: "meta" }, error: null } },
        update: { single: { data: { id, status: "draft" }, error: null } },
      },
      events: { insert: { data: null, error: null } },
    });
    const res = await PATCH(
      req(`http://localhost/api/copy/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ format: "video", body: "edited" }),
      }),
      { params },
    );
    expect(res.status).toBe(200);
    expect(currentSupabase._spies.from).toHaveBeenCalledWith("video_copy_variants");
  });

  it("404 when the variant is missing", async () => {
    currentSupabase = mockClient({
      copy_variants: { select: { single: { data: null, error: null } } },
    });
    const res = await PATCH(
      req(`http://localhost/api/copy/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ format: "image", headline: "x" }),
      }),
      { params },
    );
    expect(res.status).toBe(404);
  });

  it("400 on zod failure (missing format)", async () => {
    const res = await PATCH(
      req(`http://localhost/api/copy/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ headline: "x" }),
      }),
      { params },
    );
    expect(res.status).toBe(400);
  });

  it("409 on a duplicate when re-targeting variant_index collides", async () => {
    currentSupabase = mockClient({
      copy_variants: {
        select: { single: { data: { id, status: "draft", platform: "meta" }, error: null } },
        update: {
          single: { data: null, error: { message: "dup", code: "23505" } as { message: string } },
        },
      },
    });
    const res = await PATCH(
      req(`http://localhost/api/copy/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ format: "image", variant_index: 2 }),
      }),
      { params },
    );
    expect(res.status).toBe(409);
  });
});

describe("DELETE /api/copy/:id (archive)", () => {
  beforeEach(() => {
    currentSupabase = mockClient();
  });

  it("200 archives an image variant + emits an event", async () => {
    currentSupabase = mockClient({
      copy_variants: { update: { single: { data: { id, deleted_at: "x" }, error: null } } },
      events: { insert: { data: null, error: null } },
    });
    const res = await DELETE(
      req(`http://localhost/api/copy/${id}?format=image`, { method: "DELETE" }),
      { params },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.variant.id).toBe(id);
  });

  it("archives a video variant from the video table", async () => {
    currentSupabase = mockClient({
      video_copy_variants: { update: { single: { data: { id, deleted_at: "x" }, error: null } } },
      events: { insert: { data: null, error: null } },
    });
    const res = await DELETE(
      req(`http://localhost/api/copy/${id}?format=video`, { method: "DELETE" }),
      { params },
    );
    expect(res.status).toBe(200);
    expect(currentSupabase._spies.from).toHaveBeenCalledWith("video_copy_variants");
  });

  it("400 on a bad format", async () => {
    const res = await DELETE(
      req(`http://localhost/api/copy/${id}?format=audio`, { method: "DELETE" }),
      { params },
    );
    expect(res.status).toBe(400);
  });

  it("409 when already archived", async () => {
    currentSupabase = mockClient({
      copy_variants: {
        update: { single: { data: null, error: null } },
        select: { single: { data: { id, deleted_at: "x" }, error: null } },
      },
    });
    const res = await DELETE(
      req(`http://localhost/api/copy/${id}?format=image`, { method: "DELETE" }),
      { params },
    );
    expect(res.status).toBe(409);
  });
});
