import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { mockSupabaseClient, type SupabaseClientMock } from "@/tests/unit/helpers/supabase-mock";

let currentSupabase: SupabaseClientMock = mockSupabaseClient();
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => currentSupabase,
}));

import { GET } from "./route";

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

describe("GET /api/approvals/:id", () => {
  beforeEach(() => {
    currentSupabase = mockSupabaseClient();
  });

  it("returns the approval row on hit", async () => {
    currentSupabase = mockSupabaseClient({
      approvals: {
        select: {
          data: null,
          error: null,
          single: { data: { id: "a1", status: "pending" }, error: null },
        },
      },
    });
    const res = await GET(new NextRequest("http://localhost/api/approvals/a1"), ctx("a1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.approval).toEqual({ id: "a1", status: "pending" });
  });

  it("returns 404 on no row", async () => {
    currentSupabase = mockSupabaseClient({
      approvals: {
        select: { data: null, error: null, single: { data: null, error: null } },
      },
    });
    const res = await GET(
      new NextRequest("http://localhost/api/approvals/missing"),
      ctx("missing"),
    );
    expect(res.status).toBe(404);
  });

  it("returns 500 on supabase error", async () => {
    currentSupabase = mockSupabaseClient({
      approvals: {
        select: { data: null, error: null, single: { data: null, error: { message: "db down" } } },
      },
    });
    const res = await GET(new NextRequest("http://localhost/api/approvals/x"), ctx("x"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("db down");
  });

  it("returns 400 when no id is in the params", async () => {
    const res = await GET(new NextRequest("http://localhost/api/approvals/"), ctx(""));
    expect(res.status).toBe(400);
  });
});
