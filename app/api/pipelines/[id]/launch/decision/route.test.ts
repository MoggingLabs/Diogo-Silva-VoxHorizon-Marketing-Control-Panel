/**
 * Tests for `app/api/pipelines/[id]/launch/decision/route.ts` (#361).
 */
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mockClient } from "@/tests/unit/helpers/api-mock";
import { type SupabaseClientMock } from "@/tests/unit/helpers/supabase-mock";

let currentSupabase: SupabaseClientMock = mockClient();

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => currentSupabase,
}));

const { getReviewBundle } = vi.hoisted(() => ({
  getReviewBundle: vi.fn(),
}));
vi.mock("@/lib/review/fetch", () => ({ getReviewBundle }));

import { POST } from "./route";

const id = "11111111-1111-4111-8111-111111111111";
const params = Promise.resolve({ id });

function req(body: unknown | string): NextRequest {
  return new NextRequest(
    new Request(`http://localhost/api/pipelines/${id}/launch/decision`, {
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

const READY_BUNDLE = {
  creatives: [{ id: "a", concept: "c", status: "approved" }],
  states: [
    { creative_id: "a", stage: "compliance_review", status: "passed", override_note: null },
    { creative_id: "a", stage: "spec_validation", status: "passed", override_note: null },
  ],
  copyVariants: [
    { creative_id: "a", status: "approved" },
    { creative_id: "a", status: "approved" },
    { creative_id: "a", status: "approved" },
  ],
  signedUrls: {},
};

const BLOCKED_BUNDLE = {
  ...READY_BUNDLE,
  states: [
    { creative_id: "a", stage: "compliance_review", status: "failed", override_note: null },
    { creative_id: "a", stage: "spec_validation", status: "passed", override_note: null },
  ],
};

beforeEach(() => {
  currentSupabase = mockClient();
  getReviewBundle.mockReset();
});
afterEach(() => vi.restoreAllMocks());

const inLaunchStage = () =>
  mockClient({
    pipelines: {
      select: { single: { data: { id, status: "launch_handoff", advanced_at: {} }, error: null } },
      update: { single: { data: { id, status: "monitor" }, error: null } },
    },
    pipeline_events: { insert: { data: null, error: null } },
  });

const approveBody = {
  decision: "approved",
  confirm_paused_first: true,
  acknowledge_preconditions: true,
};

describe("POST /api/pipelines/:id/launch/decision", () => {
  it("approves + advances to monitor when preconditions hold (200)", async () => {
    currentSupabase = inLaunchStage();
    getReviewBundle.mockResolvedValue(READY_BUNDLE);
    const res = await POST(req(approveBody), { params });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.pipeline.status).toBe("monitor");
  });

  it("422 when preconditions are not met (hard gate never auto-passes)", async () => {
    currentSupabase = inLaunchStage();
    getReviewBundle.mockResolvedValue(BLOCKED_BUNDLE);
    const res = await POST(req(approveBody), { params });
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.error).toBe("launch_blocked");
  });

  it("rejects (stays in launch_handoff) with notes (200)", async () => {
    currentSupabase = inLaunchStage();
    const res = await POST(req({ decision: "rejected", notes: "hold" }), { params });
    expect(res.status).toBe(200);
    expect(getReviewBundle).not.toHaveBeenCalled();
  });

  it("400 approve without paused-first confirmation", async () => {
    const res = await POST(req({ decision: "approved", acknowledge_preconditions: true }), {
      params,
    });
    expect(res.status).toBe(400);
  });

  it("400 approve without acknowledging preconditions", async () => {
    const res = await POST(req({ decision: "approved", confirm_paused_first: true }), { params });
    expect(res.status).toBe(400);
  });

  it("400 reject without notes", async () => {
    const res = await POST(req({ decision: "rejected" }), { params });
    expect(res.status).toBe(400);
  });

  it("400 invalid JSON", async () => {
    const res = await POST(req("{"), { params });
    expect(res.status).toBe(400);
  });

  it("404 missing", async () => {
    currentSupabase = mockClient({
      pipelines: { select: { single: { data: null, error: null } } },
    });
    const res = await POST(req(approveBody), { params });
    expect(res.status).toBe(404);
  });

  it("409 wrong stage", async () => {
    currentSupabase = mockClient({
      pipelines: { select: { single: { data: { id, status: "monitor" }, error: null } } },
    });
    const res = await POST(req(approveBody), { params });
    expect(res.status).toBe(409);
  });

  it("500 read error", async () => {
    currentSupabase = mockClient({
      pipelines: { select: { single: { data: null, error: { message: "db" } } } },
    });
    const res = await POST(req(approveBody), { params });
    expect(res.status).toBe(500);
  });

  it("500 when advance update fails", async () => {
    currentSupabase = mockClient({
      pipelines: {
        select: {
          single: { data: { id, status: "launch_handoff", advanced_at: {} }, error: null },
        },
        update: { single: { data: null, error: { message: "no" } } },
      },
    });
    getReviewBundle.mockResolvedValue(READY_BUNDLE);
    const res = await POST(req(approveBody), { params });
    expect(res.status).toBe(500);
  });

  it("500 when the stage_advanced event insert fails (FIX-F: no longer swallowed)", async () => {
    // FINDING 3: the stage_advanced->monitor event is the SOLE input the
    // reducer reads. A failed insert used to console.warn + return 200
    // status='monitor', leaving the reducer at launch_handoff under a false UI
    // so a re-evaluation 409s 'invalid_state'. It is now strict (500).
    currentSupabase = mockClient({
      pipelines: {
        select: {
          single: { data: { id, status: "launch_handoff", advanced_at: {} }, error: null },
        },
        update: { single: { data: { id, status: "monitor" }, error: null } },
      },
      pipeline_events: { insert: { data: null, error: { message: "ev down" } } },
    });
    getReviewBundle.mockResolvedValue(READY_BUNDLE);
    const res = await POST(req(approveBody), { params });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(String(body.error)).toContain("ev down");
  });

  it("does NOT push to any worker launch endpoint (operator-MCP launch)", async () => {
    // The locked design holds the Meta launch on the operator's MCP (the
    // operator records entities via /work/pipeline/tools/launch before this
    // approval). The decision route must NEVER fire-and-forget to a worker
    // launch endpoint — the dead `/work/pipeline/launch` glue was removed.
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    currentSupabase = inLaunchStage();
    getReviewBundle.mockResolvedValue(READY_BUNDLE);
    const res = await POST(req(approveBody), { params });
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 5));
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
