/**
 * Tests for `app/api/creatives/[id]/decision/route.ts`.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { mockClient } from "@/tests/unit/helpers/api-mock";
import { type SupabaseClientMock } from "@/tests/unit/helpers/supabase-mock";

let currentSupabase: SupabaseClientMock = mockClient();

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => currentSupabase,
}));

import { POST } from "./route";

const id = "11111111-1111-4111-8111-111111111111";
const params = Promise.resolve({ id });

function req(url: string, init: RequestInit = {}): NextRequest {
  return new NextRequest(new Request(url, init));
}

describe("POST /api/creatives/:id/decision", () => {
  beforeEach(() => {
    currentSupabase = mockClient();
  });

  it("approves a draft creative (200)", async () => {
    currentSupabase = mockClient({
      creatives: {
        select: { single: { data: { id, status: "draft" }, error: null } },
        update: { single: { data: { id, status: "approved" }, error: null } },
      },
      events: { insert: { data: null, error: null } },
    });
    const res = await POST(
      req(`http://localhost/api/creatives/${id}/decision`, {
        method: "POST",
        body: JSON.stringify({ decision: "approve" }),
      }),
      { params },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.creative.status).toBe("approved");
  });

  it("rejects a draft creative (200)", async () => {
    currentSupabase = mockClient({
      creatives: {
        select: { single: { data: { id, status: "draft" }, error: null } },
        update: { single: { data: { id, status: "rejected" }, error: null } },
      },
      events: { insert: { data: null, error: null } },
    });
    const res = await POST(
      req(`http://localhost/api/creatives/${id}/decision`, {
        method: "POST",
        body: JSON.stringify({ decision: "reject" }),
      }),
      { params },
    );
    expect(res.status).toBe(200);
  });

  it("400 invalid JSON", async () => {
    const res = await POST(
      req(`http://localhost/api/creatives/${id}/decision`, {
        method: "POST",
        body: "{",
      }),
      { params },
    );
    expect(res.status).toBe(400);
  });

  it("400 invalid enum", async () => {
    const res = await POST(
      req(`http://localhost/api/creatives/${id}/decision`, {
        method: "POST",
        body: JSON.stringify({ decision: "halt" }),
      }),
      { params },
    );
    expect(res.status).toBe(400);
  });

  it("500 when fetch errors", async () => {
    currentSupabase = mockClient({
      creatives: { select: { single: { data: null, error: { message: "x" } } } },
    });
    const res = await POST(
      req(`http://localhost/api/creatives/${id}/decision`, {
        method: "POST",
        body: JSON.stringify({ decision: "approve" }),
      }),
      { params },
    );
    expect(res.status).toBe(500);
  });

  it("404 when missing", async () => {
    currentSupabase = mockClient({
      creatives: { select: { single: { data: null, error: null } } },
    });
    const res = await POST(
      req(`http://localhost/api/creatives/${id}/decision`, {
        method: "POST",
        body: JSON.stringify({ decision: "approve" }),
      }),
      { params },
    );
    expect(res.status).toBe(404);
  });

  it("409 when wrong status (e.g. already approved)", async () => {
    currentSupabase = mockClient({
      creatives: {
        select: { single: { data: { id, status: "approved" }, error: null } },
      },
    });
    const res = await POST(
      req(`http://localhost/api/creatives/${id}/decision`, {
        method: "POST",
        body: JSON.stringify({ decision: "approve" }),
      }),
      { params },
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("invalid_state");
  });

  it("500 when update fails", async () => {
    currentSupabase = mockClient({
      creatives: {
        select: { single: { data: { id, status: "draft" }, error: null } },
        update: { single: { data: null, error: { message: "no" } } },
      },
    });
    const res = await POST(
      req(`http://localhost/api/creatives/${id}/decision`, {
        method: "POST",
        body: JSON.stringify({ decision: "approve" }),
      }),
      { params },
    );
    expect(res.status).toBe(500);
  });

  it("warns but returns 200 when event insert fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    currentSupabase = mockClient({
      creatives: {
        select: { single: { data: { id, status: "draft" }, error: null } },
        update: { single: { data: { id, status: "approved" }, error: null } },
      },
      events: { insert: { data: null, error: { message: "events down" } } },
    });
    const res = await POST(
      req(`http://localhost/api/creatives/${id}/decision`, {
        method: "POST",
        body: JSON.stringify({ decision: "approve" }),
      }),
      { params },
    );
    expect(res.status).toBe(200);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("events down"));
    warn.mockRestore();
  });
});
