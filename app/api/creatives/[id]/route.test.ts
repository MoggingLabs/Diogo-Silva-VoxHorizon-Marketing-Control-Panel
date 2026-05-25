/**
 * Tests for `app/api/creatives/[id]/route.ts` (GET + PATCH metadata + DELETE
 * archive). M4 / #594.
 *
 * Guardrail coverage: PATCH refuses to touch `status` (no status key is ever
 * written, even if the body smuggles one in) — status transitions must go
 * through the decision route. Archive is a soft-delete (compare-and-set).
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

function req(method: string, body?: unknown): NextRequest {
  return new NextRequest(
    new Request(`http://localhost/api/creatives/${id}`, {
      method,
      ...(body !== undefined
        ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
        : {}),
    }),
  );
}

describe("GET /api/creatives/:id", () => {
  beforeEach(() => {
    currentSupabase = mockClient();
  });

  it("200 with creative + brief + copy_variants + gate artifacts + events", async () => {
    currentSupabase = mockClient({
      creatives: {
        select: { single: { data: { id, brief_id: "b1", status: "draft" }, error: null } },
      },
      briefs: {
        select: {
          single: { data: { id: "b1", brief_id_human: "br-1", status: "approved" }, error: null },
        },
      },
      copy_variants: { select: { data: [{ id: "cv1" }], error: null } },
      qa_result: { select: { data: [{ id: "qa1", status: "pass", attempt: 1 }], error: null } },
      spec_check: { select: { data: [{ id: "sp1", status: "pass" }], error: null } },
      compliance_finding: { select: { data: [{ id: "cf1", verdict: "pass" }], error: null } },
      creative_stage_state: { select: { data: [{ id: "ss1", stage: "qa" }], error: null } },
      events: { select: { data: [{ id: "e1", kind: "creative_decided" }], error: null } },
    });
    const res = await GET(req("GET"), { params });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.creative.id).toBe(id);
    expect(body.brief.brief_id_human).toBe("br-1");
    expect(body.copy_variants).toEqual([{ id: "cv1" }]);
    expect(body.qa).toEqual([{ id: "qa1", status: "pass", attempt: 1 }]);
    expect(body.spec).toEqual([{ id: "sp1", status: "pass" }]);
    expect(body.compliance).toEqual([{ id: "cf1", verdict: "pass" }]);
    expect(body.stage_state).toEqual([{ id: "ss1", stage: "qa" }]);
    expect(body.events[0].kind).toBe("creative_decided");
  });

  it("500 when a gate-artifact read errors", async () => {
    currentSupabase = mockClient({
      creatives: { select: { single: { data: { id, brief_id: "b1" }, error: null } } },
      briefs: { select: { single: { data: { id: "b1" }, error: null } } },
      qa_result: { select: { data: null, error: { message: "qa down" } } },
    });
    const res = await GET(req("GET"), { params });
    expect(res.status).toBe(500);
  });

  it("404 when the creative is missing", async () => {
    currentSupabase = mockClient({
      creatives: { select: { single: { data: null, error: null } } },
    });
    const res = await GET(req("GET"), { params });
    expect(res.status).toBe(404);
  });

  it("500 on a DB error reading the creative", async () => {
    currentSupabase = mockClient({
      creatives: { select: { single: { data: null, error: { message: "boom" } } } },
    });
    const res = await GET(req("GET"), { params });
    expect(res.status).toBe(500);
  });

  it("500 when the copy_variants read errors", async () => {
    currentSupabase = mockClient({
      creatives: { select: { single: { data: { id, brief_id: "b1" }, error: null } } },
      briefs: { select: { single: { data: { id: "b1" }, error: null } } },
      copy_variants: { select: { data: null, error: { message: "copy down" } } },
    });
    const res = await GET(req("GET"), { params });
    expect(res.status).toBe(500);
  });
});

describe("PATCH /api/creatives/:id", () => {
  beforeEach(() => {
    currentSupabase = mockClient();
  });

  it("200 edits the editable metadata fields", async () => {
    currentSupabase = mockClient({
      creatives: {
        update: { single: { data: { id, concept: "New concept" }, error: null } },
      },
      events: { insert: { data: null, error: null } },
    });
    const res = await PATCH(req("PATCH", { concept: "New concept", offer_text: "20% off" }), {
      params,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.creative.concept).toBe("New concept");
  });

  it("guardrail: ignores a smuggled status key (never writes status)", async () => {
    const updateSpy = vi.fn();
    currentSupabase = mockClient({
      creatives: {
        update: { single: { data: { id, concept: "c" }, error: null } },
      },
      events: { insert: { data: null, error: null } },
    });
    // Wrap from() so we can inspect the update payload.
    const realFrom = currentSupabase.from;
    currentSupabase.from = vi.fn((table: string) => {
      const builder = realFrom(table) as Record<string, unknown>;
      if (table === "creatives") {
        const realUpdate = builder.update as (...a: unknown[]) => unknown;
        builder.update = vi.fn((payload: unknown) => {
          updateSpy(payload);
          return realUpdate(payload);
        });
      }
      return builder as never;
    }) as never;

    const res = await PATCH(req("PATCH", { concept: "c", status: "approved" }), { params });
    expect(res.status).toBe(200);
    // The status key must not have been forwarded to the DB update.
    expect(updateSpy).toHaveBeenCalled();
    const payload = updateSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload).not.toHaveProperty("status");
    expect(payload).toHaveProperty("concept", "c");
  });

  it("400 when the body has no editable key", async () => {
    const res = await PATCH(req("PATCH", { status: "approved" }), { params });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("nothing to update");
  });

  it("400 on invalid JSON", async () => {
    const bad = new NextRequest(
      new Request(`http://localhost/api/creatives/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: "{not json",
      }),
    );
    const res = await PATCH(bad, { params });
    expect(res.status).toBe(400);
  });

  it("400 on a zod-invalid ratio", async () => {
    const res = await PATCH(req("PATCH", { ratio: "4x3" }), { params });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("validation_failed");
  });

  it("404 when the row is missing / already archived", async () => {
    currentSupabase = mockClient({
      creatives: { update: { single: { data: null, error: null } } },
    });
    const res = await PATCH(req("PATCH", { concept: "x" }), { params });
    expect(res.status).toBe(404);
  });

  it("500 on a DB error during update", async () => {
    currentSupabase = mockClient({
      creatives: { update: { single: { data: null, error: { message: "db" } } } },
    });
    const res = await PATCH(req("PATCH", { concept: "x" }), { params });
    expect(res.status).toBe(500);
  });
});

describe("DELETE /api/creatives/:id (archive)", () => {
  beforeEach(() => {
    currentSupabase = mockClient();
  });

  it("200 soft-deletes and stamps deleted_at", async () => {
    currentSupabase = mockClient({
      creatives: {
        update: { single: { data: { id, deleted_at: "2026-01-01T00:00:00Z" }, error: null } },
      },
      events: { insert: { data: null, error: null } },
    });
    const res = await DELETE(req("DELETE"), { params });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.creative.deleted_at).toBe("2026-01-01T00:00:00Z");
  });

  it("409 when already archived (compare-and-set finds the row archived)", async () => {
    currentSupabase = mockClient({
      creatives: {
        update: { single: { data: null, error: null } },
        select: { single: { data: { id, deleted_at: "2026-01-01T00:00:00Z" }, error: null } },
      },
    });
    const res = await DELETE(req("DELETE"), { params });
    expect(res.status).toBe(409);
  });

  it("404 when the creative does not exist", async () => {
    currentSupabase = mockClient({
      creatives: {
        update: { single: { data: null, error: null } },
        select: { single: { data: null, error: null } },
      },
    });
    const res = await DELETE(req("DELETE"), { params });
    expect(res.status).toBe(404);
  });

  it("500 on a DB error during archive", async () => {
    currentSupabase = mockClient({
      creatives: { update: { single: { data: null, error: { message: "nope" } } } },
    });
    const res = await DELETE(req("DELETE"), { params });
    expect(res.status).toBe(500);
  });
});
