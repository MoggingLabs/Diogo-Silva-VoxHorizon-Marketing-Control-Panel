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

function makeRequest(body: unknown, opts: { contentType?: string; raw?: string } = {}) {
  const init: RequestInit =
    opts.raw !== undefined
      ? { method: "POST", body: opts.raw, headers: { "content-type": "application/json" } }
      : {
          method: "POST",
          body: JSON.stringify(body),
          headers: { "content-type": opts.contentType ?? "application/json" },
        };
  return new NextRequest(new Request("http://localhost/api/approvals/abc/decision", init));
}

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

describe("POST /api/approvals/:id/decision", () => {
  beforeEach(() => {
    currentSupabase = mockSupabaseClient();
  });

  it("updates the row + returns 200 on the happy path", async () => {
    currentSupabase = mockSupabaseClient({
      approvals: {
        update: {
          ...EMPTY,
          single: {
            data: {
              id: "abc",
              status: "decided",
              decision: "approved",
              ekko_session_id: "s1",
              tool_name: "x",
              tool_args: {},
            },
            error: null,
          },
        },
      },
    });
    const res = await POST(makeRequest({ decision: "approved" }), ctx("abc"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.approval.status).toBe("decided");
    expect(body.approval.decision).toBe("approved");
  });

  it("returns 422 when the body is missing decision", async () => {
    const res = await POST(makeRequest({}), ctx("abc"));
    expect(res.status).toBe(422);
  });

  it("returns 422 when decision is not in the enum", async () => {
    const res = await POST(makeRequest({ decision: "maybe" }), ctx("abc"));
    expect(res.status).toBe(422);
  });

  it("returns 400 on invalid JSON", async () => {
    const res = await POST(makeRequest(undefined, { raw: "not json" }), ctx("abc"));
    expect(res.status).toBe(400);
  });

  it("returns 400 when params is missing id", async () => {
    const res = await POST(makeRequest({ decision: "approved" }), ctx(""));
    expect(res.status).toBe(400);
  });

  it("returns 500 when the supabase update errors", async () => {
    currentSupabase = mockSupabaseClient({
      approvals: {
        update: { ...EMPTY, single: { data: null, error: { message: "kaboom" } } },
      },
    });
    const res = await POST(makeRequest({ decision: "approved" }), ctx("abc"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("kaboom");
  });

  it("returns 404 when no row matches the id (already gone)", async () => {
    currentSupabase = mockSupabaseClient({
      approvals: {
        update: { ...EMPTY, single: { data: null, error: null } },
        select: { ...EMPTY, single: { data: null, error: null } },
      },
    });
    const res = await POST(makeRequest({ decision: "approved" }), ctx("abc"));
    expect(res.status).toBe(404);
  });

  it("returns 409 when row exists but status is no longer pending (idempotent)", async () => {
    currentSupabase = mockSupabaseClient({
      approvals: {
        update: { ...EMPTY, single: { data: null, error: null } },
        select: {
          ...EMPTY,
          single: {
            data: { id: "abc", status: "decided", decision: "approved" },
            error: null,
          },
        },
      },
    });
    const res = await POST(makeRequest({ decision: "approved" }), ctx("abc"));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("already_decided");
    expect(body.approval.id).toBe("abc");
  });

  it("returns 500 when the re-read after a miss errors", async () => {
    currentSupabase = mockSupabaseClient({
      approvals: {
        update: { ...EMPTY, single: { data: null, error: null } },
        select: { ...EMPTY, single: { data: null, error: { message: "re-read fail" } } },
      },
    });
    const res = await POST(makeRequest({ decision: "approved" }), ctx("abc"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("re-read fail");
  });

  it("writes to approvals_policy_cache when cache_for_session=true", async () => {
    currentSupabase = mockSupabaseClient({
      approvals: {
        update: {
          ...EMPTY,
          single: {
            data: {
              id: "abc",
              status: "decided",
              decision: "approved",
              ekko_session_id: "sess",
              tool_name: "read_file",
              tool_args: { path: "/etc/hosts" },
            },
            error: null,
          },
        },
      },
      approvals_policy_cache: { insert: { data: null, error: null } },
    });
    const res = await POST(
      makeRequest({ decision: "approved", cache_for_session: true }),
      ctx("abc"),
    );
    expect(res.status).toBe(200);
    expect(currentSupabase._spies.from).toHaveBeenCalledWith("approvals_policy_cache");
  });

  it("does NOT write to the cache when cache_for_session is false", async () => {
    currentSupabase = mockSupabaseClient({
      approvals: {
        update: {
          ...EMPTY,
          single: {
            data: {
              id: "abc",
              status: "decided",
              decision: "approved",
              ekko_session_id: "sess",
              tool_name: "read_file",
              tool_args: {},
            },
            error: null,
          },
        },
      },
    });
    await POST(makeRequest({ decision: "approved", cache_for_session: false }), ctx("abc"));
    expect(currentSupabase._spies.from).not.toHaveBeenCalledWith("approvals_policy_cache");
  });

  it("respects a custom cache_for_minutes value", async () => {
    currentSupabase = mockSupabaseClient({
      approvals: {
        update: {
          ...EMPTY,
          single: {
            data: {
              id: "abc",
              status: "decided",
              decision: "approved",
              ekko_session_id: "sess",
              tool_name: "read_file",
              tool_args: {},
            },
            error: null,
          },
        },
      },
      approvals_policy_cache: { insert: { data: null, error: null } },
    });
    await POST(
      makeRequest({ decision: "approved", cache_for_session: true, cache_for_minutes: 30 }),
      ctx("abc"),
    );
    expect(currentSupabase._spies.from).toHaveBeenCalledWith("approvals_policy_cache");
  });

  it("does NOT write to cache when the row is missing session metadata", async () => {
    currentSupabase = mockSupabaseClient({
      approvals: {
        update: {
          ...EMPTY,
          single: {
            data: { id: "abc", status: "decided", decision: "approved", tool_args: {} },
            error: null,
          },
        },
      },
    });
    await POST(makeRequest({ decision: "approved", cache_for_session: true }), ctx("abc"));
    expect(currentSupabase._spies.from).not.toHaveBeenCalledWith("approvals_policy_cache");
  });

  it("survives a cache insert failure with a warn + 200", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    currentSupabase = mockSupabaseClient({
      approvals: {
        update: {
          ...EMPTY,
          single: {
            data: {
              id: "abc",
              status: "decided",
              decision: "approved",
              ekko_session_id: "sess",
              tool_name: "read_file",
              tool_args: {},
            },
            error: null,
          },
        },
      },
      approvals_policy_cache: { insert: { data: null, error: { message: "cache down" } } },
    });
    const res = await POST(
      makeRequest({ decision: "approved", cache_for_session: true }),
      ctx("abc"),
    );
    expect(res.status).toBe(200);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("accepts approved_with_caveat as a decision", async () => {
    currentSupabase = mockSupabaseClient({
      approvals: {
        update: {
          ...EMPTY,
          single: {
            data: {
              id: "abc",
              status: "decided",
              decision: "approved_with_caveat",
              tool_args: {},
            },
            error: null,
          },
        },
      },
    });
    const res = await POST(
      makeRequest({ decision: "approved_with_caveat", notes: "with care" }),
      ctx("abc"),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.approval.decision).toBe("approved_with_caveat");
  });
});
