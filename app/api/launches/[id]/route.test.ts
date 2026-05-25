/**
 * Tests for `app/api/launches/[id]/route.ts` (GET / PATCH / DELETE).
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

import { DELETE, GET, PATCH } from "./route";

const id = "11111111-1111-4111-8111-111111111111";
const params = Promise.resolve({ id });

function req(url: string): NextRequest {
  return new NextRequest(new Request(url));
}

function patchReq(body: unknown): NextRequest {
  return new NextRequest(
    new Request(`http://localhost/api/launches/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

function delReq(): NextRequest {
  return new NextRequest(new Request(`http://localhost/api/launches/${id}`, { method: "DELETE" }));
}

describe("GET /api/launches/:id", () => {
  beforeEach(() => {
    currentSupabase = mockClient();
  });

  it("200 returns the launch", async () => {
    currentSupabase = mockClient({
      launch_packages: { select: { single: { data: { id, status: "posted" }, error: null } } },
    });
    const res = await GET(req(`http://localhost/api/launches/${id}`), { params });
    expect(res.status).toBe(200);
  });

  it("500 on error", async () => {
    currentSupabase = mockClient({
      launch_packages: { select: { single: { data: null, error: { message: "x" } } } },
    });
    const res = await GET(req(`http://localhost/api/launches/${id}`), { params });
    expect(res.status).toBe(500);
  });

  it("404 missing", async () => {
    currentSupabase = mockClient({
      launch_packages: { select: { single: { data: null, error: null } } },
    });
    const res = await GET(req(`http://localhost/api/launches/${id}`), { params });
    expect(res.status).toBe(404);
  });
});

describe("PATCH /api/launches/:id", () => {
  beforeEach(() => {
    currentSupabase = mockClient();
  });

  it("200 updates the operator annotation", async () => {
    currentSupabase = mockClient({
      launch_packages: {
        update: { single: { data: { id, decided_notes: "noted" }, error: null } },
      },
      events: { insert: { data: null, error: null } },
    });
    const res = await PATCH(patchReq({ decided_notes: "noted" }), { params });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.launch.decided_notes).toBe("noted");
  });

  it("400 when the body is empty (nothing to update)", async () => {
    const res = await PATCH(patchReq({}), { params });
    expect(res.status).toBe(400);
  });

  it("400 (guardrail) when the body tries to set status — status is a decision-route concern", async () => {
    // `status` is not in the schema, so zod strips it and the refine sees no
    // editable keys -> 400. The decision route (which re-derives the gate) is
    // the only way to change a launch's status.
    const res = await PATCH(patchReq({ status: "approved" }), { params });
    expect(res.status).toBe(400);
  });

  it("404 when the row is missing or already archived", async () => {
    currentSupabase = mockClient({
      launch_packages: { update: { single: { data: null, error: null } } },
    });
    const res = await PATCH(patchReq({ decided_notes: "x" }), { params });
    expect(res.status).toBe(404);
  });

  it("500 on a DB error", async () => {
    currentSupabase = mockClient({
      launch_packages: { update: { single: { data: null, error: { message: "boom" } } } },
    });
    const res = await PATCH(patchReq({ decided_notes: "x" }), { params });
    expect(res.status).toBe(500);
  });
});

describe("DELETE /api/launches/:id (soft-archive)", () => {
  beforeEach(() => {
    currentSupabase = mockClient();
  });

  it("200 archives a live package (sets deleted_at)", async () => {
    currentSupabase = mockClient({
      launch_packages: {
        update: { single: { data: { id, deleted_at: "2026-05-26T00:00:00Z" }, error: null } },
      },
      events: { insert: { data: null, error: null } },
    });
    const res = await DELETE(delReq(), { params });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.launch.deleted_at).not.toBeNull();
  });

  it("409 when already archived (compare-and-set finds it archived)", async () => {
    currentSupabase = mockClient({
      launch_packages: {
        update: { single: { data: null, error: null } },
        select: { single: { data: { id, deleted_at: "2026-01-01" }, error: null } },
      },
    });
    const res = await DELETE(delReq(), { params });
    expect(res.status).toBe(409);
  });

  it("404 when missing", async () => {
    currentSupabase = mockClient({
      launch_packages: {
        update: { single: { data: null, error: null } },
        select: { single: { data: null, error: null } },
      },
    });
    const res = await DELETE(delReq(), { params });
    expect(res.status).toBe(404);
  });

  it("still 200 when the audit event insert fails (non-fatal)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    currentSupabase = mockClient({
      launch_packages: {
        update: { single: { data: { id, deleted_at: "2026-05-26" }, error: null } },
      },
      events: { insert: { data: null, error: { message: "events down" } } },
    });
    const res = await DELETE(delReq(), { params });
    expect(res.status).toBe(200);
    warn.mockRestore();
  });
});
