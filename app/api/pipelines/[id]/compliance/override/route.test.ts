/**
 * Tests for `app/api/pipelines/[id]/compliance/override/route.ts`.
 *
 * The manager override is the ONLY path that releases a HARD compliance block.
 * Its load-bearing invariant is the required, non-empty `override_note` — an
 * empty justification is rejected (422), so a hard-gate release is never
 * unaudited. We also drive the malformed-body, missing-pipeline,
 * missing-gate-row, happy, and audit-event branches.
 */
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { mockClient } from "@/tests/unit/helpers/api-mock";
import { type SupabaseClientMock } from "@/tests/unit/helpers/supabase-mock";

let currentSupabase: SupabaseClientMock = mockClient();

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => currentSupabase,
}));

import { POST } from "./route";

const id = "11111111-1111-4111-8111-111111111111";
const creativeId = "22222222-2222-4222-8222-222222222222";
const copyVariantId = "33333333-3333-4333-8333-333333333333";
const params = Promise.resolve({ id });

function req(body: unknown, opts: { invalidJson?: boolean } = {}): NextRequest {
  const r = new NextRequest(
    new Request(`http://localhost/api/pipelines/${id}/compliance/override`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: opts.invalidJson ? "{not json" : JSON.stringify(body),
    }),
  );
  return r;
}

const VALID_BODY = {
  creative_id: creativeId,
  override_note: "Manager reviewed: the before/after is property-vertical and Meta-compliant.",
  decided_by: "diogo",
};

function happyClient() {
  return mockClient({
    pipelines: {
      select: { single: { data: { id, status: "compliance_review" }, error: null } },
    },
    creative_stage_state: {
      select: { single: { data: { id: "css1", status: "failed" }, error: null } },
      update: { single: { data: { id: "css1", status: "overridden" }, error: null } },
    },
    compliance_finding: { update: { data: null, error: null } },
    pipeline_events: { insert: { data: null, error: null } },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /api/pipelines/:id/compliance/override", () => {
  it("400 on malformed JSON", async () => {
    currentSupabase = happyClient();
    const res = await POST(req(null, { invalidJson: true }), { params });
    expect(res.status).toBe(400);
  });

  it("422 when override_note is missing (no justification, no release)", async () => {
    currentSupabase = happyClient();
    const res = await POST(req({ creative_id: creativeId, decided_by: "diogo" }), { params });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe("validation_failed");
  });

  it("422 when override_note is empty/whitespace (empty justification rejected)", async () => {
    currentSupabase = happyClient();
    const res = await POST(
      req({ creative_id: creativeId, override_note: "   ", decided_by: "diogo" }),
      { params },
    );
    expect(res.status).toBe(422);
  });

  it("422 when creative_id is not a uuid", async () => {
    currentSupabase = happyClient();
    const res = await POST(req({ creative_id: "not-a-uuid", override_note: "ok reason" }), {
      params,
    });
    expect(res.status).toBe(422);
  });

  it("404 when the pipeline does not exist", async () => {
    currentSupabase = mockClient({
      pipelines: { select: { single: { data: null, error: null } } },
    });
    const res = await POST(req(VALID_BODY), { params });
    expect(res.status).toBe(404);
  });

  it("500 when the pipeline read errors", async () => {
    currentSupabase = mockClient({
      pipelines: { select: { single: { data: null, error: { message: "boom" } } } },
    });
    const res = await POST(req(VALID_BODY), { params });
    expect(res.status).toBe(500);
  });

  it("404 when the compliance gate row is missing for the creative", async () => {
    currentSupabase = mockClient({
      pipelines: {
        select: { single: { data: { id, status: "compliance_review" }, error: null } },
      },
      creative_stage_state: { select: { single: { data: null, error: null } } },
    });
    const res = await POST(req(VALID_BODY), { params });
    expect(res.status).toBe(404);
  });

  it("500 when the gate-row read errors", async () => {
    currentSupabase = mockClient({
      pipelines: {
        select: { single: { data: { id, status: "compliance_review" }, error: null } },
      },
      creative_stage_state: {
        select: { single: { data: null, error: { message: "css read fail" } } },
      },
    });
    const res = await POST(req(VALID_BODY), { params });
    expect(res.status).toBe(500);
  });

  it("happy path: releases the gate to overridden + records the audit", async () => {
    currentSupabase = happyClient();
    const res = await POST(req(VALID_BODY), { params });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.status).toBe("overridden");
    expect(body.decided_by).toBe("diogo");
    expect(typeof body.decided_at).toBe("string");
    // The audit event row is written to pipeline_events.
    expect(currentSupabase._spies.from).toHaveBeenCalledWith("pipeline_events");
    // The finding-level audit update is attempted.
    expect(currentSupabase._spies.from).toHaveBeenCalledWith("compliance_finding");
  });

  it("happy path with copy_variant_id scopes the finding audit", async () => {
    currentSupabase = happyClient();
    const res = await POST(req({ ...VALID_BODY, copy_variant_id: copyVariantId }), { params });
    expect(res.status).toBe(200);
  });

  it("defaults decided_by to 'manager' when omitted", async () => {
    currentSupabase = happyClient();
    const res = await POST(req({ creative_id: creativeId, override_note: "valid reason here" }), {
      params,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.decided_by).toBe("manager");
  });

  it("500 when the override update fails", async () => {
    currentSupabase = mockClient({
      pipelines: {
        select: { single: { data: { id, status: "compliance_review" }, error: null } },
      },
      creative_stage_state: {
        select: { single: { data: { id: "css1", status: "failed" }, error: null } },
        update: { single: { data: null, error: { message: "update race" } } },
      },
    });
    const res = await POST(req(VALID_BODY), { params });
    expect(res.status).toBe(500);
  });

  it("warns but still 200 when the audit event insert fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    currentSupabase = mockClient({
      pipelines: {
        select: { single: { data: { id, status: "compliance_review" }, error: null } },
      },
      creative_stage_state: {
        select: { single: { data: { id: "css1", status: "failed" }, error: null } },
        update: { single: { data: { id: "css1", status: "overridden" }, error: null } },
      },
      compliance_finding: { update: { data: null, error: null } },
      pipeline_events: { insert: { data: null, error: { message: "events down" } } },
    });
    const res = await POST(req(VALID_BODY), { params });
    expect(res.status).toBe(200);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("events down"));
    warn.mockRestore();
  });

  it("warns but still 200 when the finding audit update fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    currentSupabase = mockClient({
      pipelines: {
        select: { single: { data: { id, status: "compliance_review" }, error: null } },
      },
      creative_stage_state: {
        select: { single: { data: { id: "css1", status: "failed" }, error: null } },
        update: { single: { data: { id: "css1", status: "overridden" }, error: null } },
      },
      compliance_finding: { update: { data: null, error: { message: "finding audit fail" } } },
      pipeline_events: { insert: { data: null, error: null } },
    });
    const res = await POST(req(VALID_BODY), { params });
    expect(res.status).toBe(200);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("finding audit fail"));
    warn.mockRestore();
  });
});
