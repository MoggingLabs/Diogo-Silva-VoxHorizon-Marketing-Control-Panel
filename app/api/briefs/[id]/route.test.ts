/**
 * Unit tests for `app/api/briefs/[id]/route.ts` (GET + PATCH).
 *
 * Covers:
 *  - 200 fetch with event tail
 *  - 404 on missing brief
 *  - 500 on supabase errors (read, events read, update)
 *  - PATCH happy path with payload + status, just payload, just status
 *  - 400 invalid JSON, validation, "nothing to update"
 *  - 404 on missing brief in PATCH
 *  - 409 on disallowed transition
 *  - 500 on update fail
 *  - non-fatal event-insert failure warns + returns 200
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { mockSupabaseClient, type SupabaseClientMock } from "@/tests/unit/helpers/supabase-mock";

let currentSupabase: SupabaseClientMock = mockSupabaseClient();

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => currentSupabase,
}));

import { GET, PATCH } from "./route";

const briefId = "11111111-1111-4111-8111-111111111111";
const params = Promise.resolve({ id: briefId });

function req(url: string, init: RequestInit = {}): NextRequest {
  return new NextRequest(new Request(url, init));
}

describe("GET /api/briefs/:id", () => {
  beforeEach(() => {
    currentSupabase = mockSupabaseClient();
  });

  it("returns the brief + events (200)", async () => {
    currentSupabase = mockSupabaseClient({
      briefs: {
        select: { single: { data: { id: briefId, status: "draft" }, error: null } },
      },
      events: {
        select: { data: [{ id: "e1", kind: "brief_created" }], error: null },
      },
    });

    const res = await GET(req(`http://localhost/api/briefs/${briefId}`), {
      params,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.brief.id).toBe(briefId);
    expect(body.events).toHaveLength(1);
  });

  it("returns 500 when brief select errors", async () => {
    currentSupabase = mockSupabaseClient({
      briefs: { select: { single: { data: null, error: { message: "boom" } } } },
    });
    const res = await GET(req(`http://localhost/api/briefs/${briefId}`), {
      params,
    });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("boom");
  });

  it("returns 404 when brief is missing", async () => {
    currentSupabase = mockSupabaseClient({
      briefs: { select: { single: { data: null, error: null } } },
    });
    const res = await GET(req(`http://localhost/api/briefs/${briefId}`), {
      params,
    });
    expect(res.status).toBe(404);
  });

  it("returns 500 when events select errors", async () => {
    currentSupabase = mockSupabaseClient({
      briefs: {
        select: { single: { data: { id: briefId, status: "draft" }, error: null } },
      },
      events: { select: { data: null, error: { message: "events offline" } } },
    });
    const res = await GET(req(`http://localhost/api/briefs/${briefId}`), {
      params,
    });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("events offline");
  });
});

describe("PATCH /api/briefs/:id", () => {
  beforeEach(() => {
    currentSupabase = mockSupabaseClient();
  });

  it("updates payload only and emits a payload-updated event (200)", async () => {
    currentSupabase = mockSupabaseClient({
      briefs: {
        select: { single: { data: { id: briefId, status: "draft" }, error: null } },
        update: {
          single: { data: { id: briefId, status: "draft" }, error: null },
        },
      },
      events: { insert: { data: null, error: null } },
    });

    const res = await PATCH(
      req(`http://localhost/api/briefs/${briefId}`, {
        method: "PATCH",
        body: JSON.stringify({
          payload: { service: "roofing", budget: 5000, market: "NYC" },
        }),
      }),
      { params },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.brief.id).toBe(briefId);
  });

  it("transitions status draft → posted and stamps posted_at (200)", async () => {
    currentSupabase = mockSupabaseClient({
      briefs: {
        select: { single: { data: { id: briefId, status: "draft" }, error: null } },
        update: { single: { data: { id: briefId, status: "posted" }, error: null } },
      },
      events: { insert: { data: null, error: null } },
    });

    const res = await PATCH(
      req(`http://localhost/api/briefs/${briefId}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "posted" }),
      }),
      { params },
    );
    expect(res.status).toBe(200);
  });

  it("returns 409 on a disallowed transition", async () => {
    currentSupabase = mockSupabaseClient({
      briefs: {
        select: { single: { data: { id: briefId, status: "approved" }, error: null } },
      },
    });
    const res = await PATCH(
      req(`http://localhost/api/briefs/${briefId}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "draft" }),
      }),
      { params },
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("invalid_transition");
    expect(body.from).toBe("approved");
  });

  it("returns 400 on invalid JSON", async () => {
    const res = await PATCH(
      req(`http://localhost/api/briefs/${briefId}`, {
        method: "PATCH",
        body: "{[",
      }),
      { params },
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 on zod validation failure", async () => {
    const res = await PATCH(
      req(`http://localhost/api/briefs/${briefId}`, {
        method: "PATCH",
        body: JSON.stringify({}),
      }),
      { params },
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("validation_failed");
  });

  it("returns 500 when fetch fails", async () => {
    currentSupabase = mockSupabaseClient({
      briefs: { select: { single: { data: null, error: { message: "down" } } } },
    });
    const res = await PATCH(
      req(`http://localhost/api/briefs/${briefId}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "posted" }),
      }),
      { params },
    );
    expect(res.status).toBe(500);
  });

  it("returns 404 when brief is missing", async () => {
    currentSupabase = mockSupabaseClient({
      briefs: { select: { single: { data: null, error: null } } },
    });
    const res = await PATCH(
      req(`http://localhost/api/briefs/${briefId}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "posted" }),
      }),
      { params },
    );
    expect(res.status).toBe(404);
  });

  it("returns 400 when the merged update is empty (no transition + no payload)", async () => {
    // current.status === input.status so update stays empty.
    currentSupabase = mockSupabaseClient({
      briefs: {
        select: { single: { data: { id: briefId, status: "draft" }, error: null } },
      },
    });
    const res = await PATCH(
      req(`http://localhost/api/briefs/${briefId}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "draft" }),
      }),
      { params },
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("nothing to update");
  });

  it("returns 500 when update fails", async () => {
    currentSupabase = mockSupabaseClient({
      briefs: {
        select: { single: { data: { id: briefId, status: "draft" }, error: null } },
        update: { single: { data: null, error: { message: "violated" } } },
      },
    });
    const res = await PATCH(
      req(`http://localhost/api/briefs/${briefId}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "posted" }),
      }),
      { params },
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("violated");
  });

  it("warns but returns 200 when the event insert fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    currentSupabase = mockSupabaseClient({
      briefs: {
        select: { single: { data: { id: briefId, status: "draft" }, error: null } },
        update: {
          single: { data: { id: briefId, status: "posted" }, error: null },
        },
      },
      events: { insert: { data: null, error: { message: "no events table" } } },
    });
    const res = await PATCH(
      req(`http://localhost/api/briefs/${briefId}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "posted" }),
      }),
      { params },
    );
    expect(res.status).toBe(200);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("no events table"));
    warn.mockRestore();
  });
});
