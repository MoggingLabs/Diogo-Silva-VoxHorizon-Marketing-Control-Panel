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
});
