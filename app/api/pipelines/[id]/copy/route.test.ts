/**
 * Tests for `app/api/pipelines/[id]/copy/route.ts` (#359).
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
const creativeId = "22222222-2222-4222-8222-222222222222";
const variantId = "33333333-3333-4333-8333-333333333333";
const params = Promise.resolve({ id });

function req(body: unknown | string): NextRequest {
  return new NextRequest(
    new Request(`http://localhost/api/pipelines/${id}/copy`, {
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

const inCopyStage = (extra: Record<string, unknown> = {}) =>
  mockClient({
    pipelines: { select: { single: { data: { id, status: "copy" }, error: null } } },
    copy_variants: {
      insert: { single: { data: { id: variantId, status: "draft" }, error: null } },
      update: { single: { data: { id: variantId, status: "draft" }, error: null } },
    },
    ...extra,
  });

beforeEach(() => {
  currentSupabase = mockClient();
});
afterEach(() => vi.restoreAllMocks());

describe("POST /api/pipelines/:id/copy", () => {
  it("creates a new variant (201) with char validation", async () => {
    currentSupabase = inCopyStage();
    const res = await POST(
      req({ creative_id: creativeId, platform: "meta", variant_index: 1, headline: "Roof help" }),
      { params },
    );
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.variant.id).toBe(variantId);
  });

  it("edits an existing variant in place (200) and resets to draft (re-arm)", async () => {
    currentSupabase = inCopyStage();
    const res = await POST(
      req({ id: variantId, creative_id: creativeId, variant_index: 1, body: "x".repeat(10) }),
      { params },
    );
    expect(res.status).toBe(200);
  });

  it("flags an over-limit field in the stored validation (still 201)", async () => {
    currentSupabase = inCopyStage();
    const res = await POST(
      // headline hard cap on meta feed is 255
      req({ creative_id: creativeId, variant_index: 1, headline: "h".repeat(300) }),
      { params },
    );
    expect(res.status).toBe(201);
  });

  it("handles a non-limited platform (tiktok) by counting only", async () => {
    currentSupabase = inCopyStage();
    const res = await POST(
      req({
        creative_id: creativeId,
        platform: "tiktok",
        variant_index: 1,
        headline: "hi",
        body: "b",
        description: "d",
      }),
      { params },
    );
    expect(res.status).toBe(201);
  });

  it("400 invalid JSON", async () => {
    const res = await POST(req("{"), { params });
    expect(res.status).toBe(400);
  });

  it("400 zod fail (missing creative_id)", async () => {
    const res = await POST(req({ variant_index: 1 }), { params });
    expect(res.status).toBe(400);
  });

  it("404 missing pipeline", async () => {
    currentSupabase = mockClient({
      pipelines: { select: { single: { data: null, error: null } } },
    });
    const res = await POST(req({ creative_id: creativeId, variant_index: 1 }), { params });
    expect(res.status).toBe(404);
  });

  it("409 wrong stage", async () => {
    currentSupabase = mockClient({
      pipelines: { select: { single: { data: { id, status: "review" }, error: null } } },
    });
    const res = await POST(req({ creative_id: creativeId, variant_index: 1 }), { params });
    expect(res.status).toBe(409);
  });

  it("500 read error", async () => {
    currentSupabase = mockClient({
      pipelines: { select: { single: { data: null, error: { message: "db" } } } },
    });
    const res = await POST(req({ creative_id: creativeId, variant_index: 1 }), { params });
    expect(res.status).toBe(500);
  });

  it("500 when insert fails", async () => {
    currentSupabase = mockClient({
      pipelines: { select: { single: { data: { id, status: "copy" }, error: null } } },
      copy_variants: { insert: { single: { data: null, error: { message: "no" } } } },
    });
    const res = await POST(req({ creative_id: creativeId, variant_index: 1 }), { params });
    expect(res.status).toBe(500);
  });

  it("500 when update fails", async () => {
    currentSupabase = mockClient({
      pipelines: { select: { single: { data: { id, status: "copy" }, error: null } } },
      copy_variants: { update: { single: { data: null, error: { message: "no" } } } },
    });
    const res = await POST(req({ id: variantId, creative_id: creativeId, variant_index: 1 }), {
      params,
    });
    expect(res.status).toBe(500);
  });
});
