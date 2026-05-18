import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  mockSupabaseClient,
  type SupabaseClientMock,
  type SupabaseMockResult,
} from "@/tests/unit/helpers/supabase-mock";

let currentSupabase: SupabaseClientMock = mockSupabaseClient();
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => currentSupabase,
}));

import { POST } from "./route";

const EMPTY: SupabaseMockResult = { data: null, error: null };

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

function makeRequest() {
  return new NextRequest(
    new Request("http://localhost/api/approvals/x/cancel", { method: "POST" }),
  );
}

describe("POST /api/approvals/:id/cancel", () => {
  beforeEach(() => {
    currentSupabase = mockSupabaseClient();
  });

  it("cancels a pending row + returns 200 with cancelled=true", async () => {
    currentSupabase = mockSupabaseClient({
      approvals: {
        update: { ...EMPTY, single: { data: { id: "x", status: "cancelled" }, error: null } },
      },
    });
    const res = await POST(makeRequest(), ctx("x"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cancelled).toBe(true);
  });

  it("returns 200 + cancelled=false when row is already decided", async () => {
    currentSupabase = mockSupabaseClient({
      approvals: {
        update: { ...EMPTY, single: { data: null, error: null } },
        select: { ...EMPTY, single: { data: { id: "x", status: "decided" }, error: null } },
      },
    });
    const res = await POST(makeRequest(), ctx("x"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cancelled).toBe(false);
    expect(body.approval.status).toBe("decided");
  });

  it("returns 404 when no row exists", async () => {
    currentSupabase = mockSupabaseClient({
      approvals: {
        update: { ...EMPTY, single: { data: null, error: null } },
        select: { ...EMPTY, single: { data: null, error: null } },
      },
    });
    const res = await POST(makeRequest(), ctx("missing"));
    expect(res.status).toBe(404);
  });

  it("returns 500 when the update errors", async () => {
    currentSupabase = mockSupabaseClient({
      approvals: {
        update: { ...EMPTY, single: { data: null, error: { message: "update fail" } } },
      },
    });
    const res = await POST(makeRequest(), ctx("x"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("update fail");
  });

  it("returns 500 when the re-read after a miss errors", async () => {
    currentSupabase = mockSupabaseClient({
      approvals: {
        update: { ...EMPTY, single: { data: null, error: null } },
        select: { ...EMPTY, single: { data: null, error: { message: "read fail" } } },
      },
    });
    const res = await POST(makeRequest(), ctx("x"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("read fail");
  });

  it("returns 400 with missing id", async () => {
    const res = await POST(makeRequest(), ctx(""));
    expect(res.status).toBe(400);
  });
});
