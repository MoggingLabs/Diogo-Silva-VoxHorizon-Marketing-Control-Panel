/**
 * Tests for `app/api/pipelines/[id]/copy/decision/route.ts` (#359).
 */
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mockClient } from "@/tests/unit/helpers/api-mock";
import { type SupabaseClientMock } from "@/tests/unit/helpers/supabase-mock";

let currentSupabase: SupabaseClientMock = mockClient();

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => currentSupabase,
}));

import { POST } from "./route";

const id = "11111111-1111-4111-8111-111111111111";
const variantId = "33333333-3333-4333-8333-333333333333";
const params = Promise.resolve({ id });

function req(body: unknown | string): NextRequest {
  return new NextRequest(
    new Request(`http://localhost/api/pipelines/${id}/copy/decision`, {
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

const inCopyStage = () =>
  mockClient({
    pipelines: { select: { single: { data: { id, status: "copy" }, error: null } } },
    copy_variants: {
      update: { single: { data: { id: variantId, status: "approved" }, error: null } },
    },
  });

beforeEach(() => {
  currentSupabase = mockClient();
});
afterEach(() => vi.restoreAllMocks());

describe("POST /api/pipelines/:id/copy/decision", () => {
  it("approves a variant (200)", async () => {
    currentSupabase = inCopyStage();
    const res = await POST(req({ id: variantId, decision: "approved" }), { params });
    expect(res.status).toBe(200);
  });

  it("rejects a variant with notes (200)", async () => {
    currentSupabase = inCopyStage();
    const res = await POST(req({ id: variantId, decision: "rejected", notes: "off brand" }), {
      params,
    });
    expect(res.status).toBe(200);
  });

  it("400 reject without notes", async () => {
    const res = await POST(req({ id: variantId, decision: "rejected" }), { params });
    expect(res.status).toBe(400);
  });

  it("400 invalid JSON", async () => {
    const res = await POST(req("{"), { params });
    expect(res.status).toBe(400);
  });

  it("404 missing pipeline", async () => {
    currentSupabase = mockClient({
      pipelines: { select: { single: { data: null, error: null } } },
    });
    const res = await POST(req({ id: variantId, decision: "approved" }), { params });
    expect(res.status).toBe(404);
  });

  it("409 wrong stage", async () => {
    currentSupabase = mockClient({
      pipelines: { select: { single: { data: { id, status: "review" }, error: null } } },
    });
    const res = await POST(req({ id: variantId, decision: "approved" }), { params });
    expect(res.status).toBe(409);
  });

  it("500 read error", async () => {
    currentSupabase = mockClient({
      pipelines: { select: { single: { data: null, error: { message: "db" } } } },
    });
    const res = await POST(req({ id: variantId, decision: "approved" }), { params });
    expect(res.status).toBe(500);
  });

  it("500 when update fails", async () => {
    currentSupabase = mockClient({
      pipelines: { select: { single: { data: { id, status: "copy" }, error: null } } },
      copy_variants: { update: { single: { data: null, error: { message: "no" } } } },
    });
    const res = await POST(req({ id: variantId, decision: "approved" }), { params });
    expect(res.status).toBe(500);
  });

  // -------------------------------------------------------------------------
  // B2: video creative copy variant lives in `video_copy_variants`. When the id
  // is not an image variant (copy_variants update matches no row), the route
  // falls through and updates the video parity table with the SAME request shape.
  // -------------------------------------------------------------------------
  it("approves a VIDEO variant via video_copy_variants (200)", async () => {
    currentSupabase = mockClient({
      pipelines: { select: { single: { data: { id, status: "copy" }, error: null } } },
      // image table matches nothing (data:null, error:null) -> route to video.
      copy_variants: { update: { single: { data: null, error: null } } },
      video_copy_variants: {
        update: { single: { data: { id: variantId, status: "approved" }, error: null } },
      },
    });
    const res = await POST(req({ id: variantId, decision: "approved" }), { params });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.variant.status).toBe("approved");
  });

  it("rejects a VIDEO variant with notes via video_copy_variants (200)", async () => {
    currentSupabase = mockClient({
      pipelines: { select: { single: { data: { id, status: "copy" }, error: null } } },
      copy_variants: { update: { single: { data: null, error: null } } },
      video_copy_variants: {
        update: { single: { data: { id: variantId, status: "rejected" }, error: null } },
      },
    });
    const res = await POST(req({ id: variantId, decision: "rejected", notes: "off brand" }), {
      params,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.variant.status).toBe("rejected");
  });

  it("500 when the image copy_variants update errors (does not fall through)", async () => {
    // A real DB error on the image update is a hard 500; we must NOT silently
    // try the video table after an image-table error.
    currentSupabase = mockClient({
      pipelines: { select: { single: { data: { id, status: "copy" }, error: null } } },
      copy_variants: { update: { single: { data: null, error: { message: "db down" } } } },
      video_copy_variants: {
        update: { single: { data: { id: variantId, status: "approved" }, error: null } },
      },
    });
    const res = await POST(req({ id: variantId, decision: "approved" }), { params });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("db down");
  });

  it("500 when the variant is in neither table", async () => {
    currentSupabase = mockClient({
      pipelines: { select: { single: { data: { id, status: "copy" }, error: null } } },
      copy_variants: { update: { single: { data: null, error: null } } },
      video_copy_variants: { update: { single: { data: null, error: { message: "no row" } } } },
    });
    const res = await POST(req({ id: variantId, decision: "approved" }), { params });
    expect(res.status).toBe(500);
  });
});
