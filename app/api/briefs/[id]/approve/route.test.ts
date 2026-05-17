/**
 * Tests for `app/api/briefs/[id]/approve/route.ts`.
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

const briefId = "11111111-1111-4111-8111-111111111111";
const params = Promise.resolve({ id: briefId });

function req(url: string, init: RequestInit = {}): NextRequest {
  return new NextRequest(new Request(url, init));
}

describe("POST /api/briefs/:id/approve", () => {
  beforeEach(() => {
    currentSupabase = mockClient();
  });

  it("approves a posted brief without notes (200)", async () => {
    currentSupabase = mockClient({
      briefs: {
        select: { single: { data: { id: briefId, status: "posted" }, error: null } },
        update: {
          single: { data: { id: briefId, status: "approved" }, error: null },
        },
      },
      events: { insert: { data: null, error: null } },
    });

    const res = await POST(
      req(`http://localhost/api/briefs/${briefId}/approve`, {
        method: "POST",
        body: JSON.stringify({ decision: "approved" }),
      }),
      { params },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.brief.status).toBe("approved");
  });

  it("records notes on rejection (200)", async () => {
    currentSupabase = mockClient({
      briefs: {
        select: { single: { data: { id: briefId, status: "posted" }, error: null } },
        update: {
          single: { data: { id: briefId, status: "rejected" }, error: null },
        },
      },
      events: { insert: { data: null, error: null } },
    });

    const res = await POST(
      req(`http://localhost/api/briefs/${briefId}/approve`, {
        method: "POST",
        body: JSON.stringify({ decision: "rejected", notes: "wrong angle" }),
      }),
      { params },
    );
    expect(res.status).toBe(200);
  });

  it("400 on invalid JSON", async () => {
    const res = await POST(
      req(`http://localhost/api/briefs/${briefId}/approve`, {
        method: "POST",
        body: "}}",
      }),
      { params },
    );
    expect(res.status).toBe(400);
  });

  it("400 when notes are required but missing", async () => {
    const res = await POST(
      req(`http://localhost/api/briefs/${briefId}/approve`, {
        method: "POST",
        body: JSON.stringify({ decision: "rejected" }),
      }),
      { params },
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("validation_failed");
  });

  it("500 when brief fetch errors", async () => {
    currentSupabase = mockClient({
      briefs: { select: { single: { data: null, error: { message: "boom" } } } },
    });
    const res = await POST(
      req(`http://localhost/api/briefs/${briefId}/approve`, {
        method: "POST",
        body: JSON.stringify({ decision: "approved" }),
      }),
      { params },
    );
    expect(res.status).toBe(500);
  });

  it("404 when brief missing", async () => {
    currentSupabase = mockClient({
      briefs: { select: { single: { data: null, error: null } } },
    });
    const res = await POST(
      req(`http://localhost/api/briefs/${briefId}/approve`, {
        method: "POST",
        body: JSON.stringify({ decision: "approved" }),
      }),
      { params },
    );
    expect(res.status).toBe(404);
  });

  it("409 when not in posted state", async () => {
    currentSupabase = mockClient({
      briefs: {
        select: { single: { data: { id: briefId, status: "draft" }, error: null } },
      },
    });
    const res = await POST(
      req(`http://localhost/api/briefs/${briefId}/approve`, {
        method: "POST",
        body: JSON.stringify({ decision: "approved" }),
      }),
      { params },
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("invalid_state");
    expect(body.current).toBe("draft");
  });

  it("500 when update fails", async () => {
    currentSupabase = mockClient({
      briefs: {
        select: { single: { data: { id: briefId, status: "posted" }, error: null } },
        update: { single: { data: null, error: { message: "no go" } } },
      },
    });
    const res = await POST(
      req(`http://localhost/api/briefs/${briefId}/approve`, {
        method: "POST",
        body: JSON.stringify({ decision: "approved" }),
      }),
      { params },
    );
    expect(res.status).toBe(500);
  });

  it("warns but returns 200 when event insert fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    currentSupabase = mockClient({
      briefs: {
        select: { single: { data: { id: briefId, status: "posted" }, error: null } },
        update: {
          single: { data: { id: briefId, status: "approved" }, error: null },
        },
      },
      events: { insert: { data: null, error: { message: "events down" } } },
    });
    const res = await POST(
      req(`http://localhost/api/briefs/${briefId}/approve`, {
        method: "POST",
        body: JSON.stringify({ decision: "approved" }),
      }),
      { params },
    );
    expect(res.status).toBe(200);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("events down"));
    warn.mockRestore();
  });
});
