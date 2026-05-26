/**
 * Tests for `app/api/pipelines/operator/route.ts` -- the operator-driven
 * kickoff. The route creates a pipeline, stores the manager's free-text
 * instruction in config_draft, and synchronously enqueues an
 * operator_dispatch work_item. Silent-failure PR-3 cutover: the legacy
 * fire-and-forget `dispatchOperator` is gone (the operator-daemon claims the
 * queued work_item and docker-execs into the operator container); the
 * `stage_advanced` + `operator_dispatched` event inserts are gone (the
 * auto-emit trigger on the work_item enqueue writes them from the DB).
 */
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mockClient } from "@/tests/unit/helpers/api-mock";
import { type SupabaseClientMock } from "@/tests/unit/helpers/supabase-mock";

let currentSupabase: SupabaseClientMock = mockClient();

// `@/lib/operator/dispatch` imports `server-only`; neutralise it so the jsdom
// route-test project can load the (partially mocked) module.
vi.mock("server-only", () => ({}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => currentSupabase,
}));

const { enqueueWorkItem } = vi.hoisted(() => ({
  enqueueWorkItem: vi.fn<(opts: unknown) => Promise<{ id: string; duplicate: boolean }>>(
    async () => ({ id: "wi-1", duplicate: false }),
  ),
}));
vi.mock("@/lib/work-queue/enqueue", () => ({ enqueueWorkItem }));

import { POST } from "./route";

function req(body: unknown): NextRequest {
  return new NextRequest(
    new Request("http://localhost/api/pipelines/operator", {
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
      headers: { "content-type": "application/json" },
    }),
  );
}

function flush() {
  return new Promise((r) => setTimeout(r, 5));
}

beforeEach(() => {
  currentSupabase = mockClient();
  enqueueWorkItem.mockReset();
  enqueueWorkItem.mockResolvedValue({ id: "wi-1", duplicate: false });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /api/pipelines/operator", () => {
  it("creates a pipeline, stores the instruction, and enqueues the operator dispatch (201)", async () => {
    currentSupabase = mockClient({
      pipelines: {
        insert: { single: { data: { id: "p1", status: "configuration" }, error: null } },
      },
    });

    const res = await POST(req({ instruction: "4 roofing ads, Austin, $99 inspection" }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.pipeline.id).toBe("p1");

    // The insert carried the instruction in config_draft + defaulted to image.
    const insertFn = (
      currentSupabase._spies.from.mock.results[0]?.value as
        | Record<string, ReturnType<typeof vi.fn>>
        | undefined
    )?.insert;
    expect(insertFn).toBeTruthy();
    const insertArg = insertFn!.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(insertArg.format_choice).toBe("image");
    expect((insertArg.config_draft as Record<string, unknown>).operator_instruction).toContain(
      "roofing",
    );

    // Silent-failure PR-3: the operator was enqueued (not fire-and-forget).
    // The legacy `dispatchOperator` call is gone -- the operator-daemon
    // claims the queued work_item.
    await flush();
    expect(enqueueWorkItem).toHaveBeenCalledTimes(1);
    const opts = enqueueWorkItem.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(opts.kind).toBe("operator_dispatch");
    expect((opts.payload as Record<string, unknown>).instruction).toContain("roofing");
  });

  it("honours an explicit format_choice + client_id", async () => {
    currentSupabase = mockClient({
      pipelines: {
        insert: { single: { data: { id: "p2", status: "configuration" }, error: null } },
      },
      pipeline_events: { insert: { data: null, error: null } },
    });
    const res = await POST(
      req({
        instruction: "two remodeling ads",
        format_choice: "both",
        client_id: "22222222-2222-4222-8222-222222222222",
      }),
    );
    expect(res.status).toBe(201);
    const insertFn = (
      currentSupabase._spies.from.mock.results[0]?.value as
        | Record<string, ReturnType<typeof vi.fn>>
        | undefined
    )?.insert;
    const insertArg = insertFn!.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(insertArg.format_choice).toBe("both");
    expect(insertArg.client_id).toBe("22222222-2222-4222-8222-222222222222");
  });

  it("returns 422 when instruction is missing/empty", async () => {
    expect((await POST(req({}))).status).toBe(422);
    expect((await POST(req({ instruction: "   " }))).status).toBe(422);
  });

  it("returns 400 on invalid JSON", async () => {
    const res = await POST(req("not json"));
    expect(res.status).toBe(400);
  });

  it("returns 500 when the insert fails (no enqueue)", async () => {
    currentSupabase = mockClient({
      pipelines: { insert: { single: { data: null, error: { message: "dup key" } } } },
    });
    const res = await POST(req({ instruction: "x" }));
    expect(res.status).toBe(500);
    await flush();
    expect(enqueueWorkItem).not.toHaveBeenCalled();
  });

  // -- silent-failure foundational redesign PR-2b: dual-write to work_item --

  it("dual-writes a work_item with the right kind + idempotency_key + createdBy", async () => {
    currentSupabase = mockClient({
      pipelines: {
        insert: { single: { data: { id: "p-dw", status: "configuration" }, error: null } },
      },
      pipeline_events: { insert: { data: null, error: null } },
    });
    const res = await POST(req({ instruction: "siding ads" }));
    expect(res.status).toBe(201);
    expect(enqueueWorkItem).toHaveBeenCalledTimes(1);
    const opts = enqueueWorkItem.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(opts.kind).toBe("operator_dispatch");
    expect(opts.pipelineId).toBe("p-dw");
    expect(opts.idempotencyKey).toBe("op-disp:p-dw:configuration:kickoff");
    expect(opts.createdBy).toBe("api/pipelines/operator");
    const payload = opts.payload as Record<string, unknown>;
    expect(payload.stage).toBe("configuration");
    expect(String(payload.instruction)).toContain("siding");
  });

  it("returns 500 and rolls back the pipeline when enqueueWorkItem throws", async () => {
    enqueueWorkItem.mockRejectedValueOnce(new Error("work_item insert failed: boom"));
    currentSupabase = mockClient({
      pipelines: {
        insert: { single: { data: { id: "p-fail", status: "configuration" }, error: null } },
        delete: { data: null, error: null },
      },
    });
    const res = await POST(req({ instruction: "x" }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(String(body.error)).toContain("work_item enqueue failed");

    // The pipeline row was rolled back via supabase.from('pipelines').delete().eq('id', ...).
    const fromCalls = currentSupabase._spies.from.mock.calls.map((c) => c[0]);
    expect(fromCalls).toContain("pipelines");
  });

  it("treats a duplicate idempotency_key as 201 (the dedup branch)", async () => {
    enqueueWorkItem.mockResolvedValueOnce({ id: "wi-existing", duplicate: true });
    currentSupabase = mockClient({
      pipelines: {
        insert: { single: { data: { id: "p-dup", status: "configuration" }, error: null } },
      },
    });
    const res = await POST(req({ instruction: "x" }));
    expect(res.status).toBe(201);
    // Silent-failure PR-3: a duplicate idempotency_key short-circuits via
    // the enqueue helper's dedup branch; the route still returns 201.
    expect(enqueueWorkItem).toHaveBeenCalledTimes(1);
  });
});
