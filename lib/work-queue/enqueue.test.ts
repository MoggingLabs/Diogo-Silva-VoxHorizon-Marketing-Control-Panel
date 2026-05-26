/**
 * Unit tests for the canonical work-queue enqueue helper.
 *
 * Mocks `createAdminClient` so the helper drives a hand-rolled supabase-js
 * shape. The tests pin three load-bearing properties:
 *
 *  1. happy insert -- returns the new row's id, `duplicate: false`;
 *  2. dedup on idempotency_key -- both the probe-hit path and the
 *     race-window unique-conflict path resolve to `duplicate: true`;
 *  3. error propagation -- a non-conflict DB error throws (the calling
 *     route must 5xx; no silent fire-and-forget).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { enqueueWorkItem, type WorkItemKind } from "@/lib/work-queue/enqueue";

vi.mock("server-only", () => ({}));

const createAdminClient = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => createAdminClient(),
}));

type ProbeResult = {
  data: { id: string } | null;
  error: { code?: string; message?: string } | null;
};

type InsertResult = {
  data: { id: string } | null;
  error: { code?: string; message?: string } | null;
};

type FakeOpts = {
  probe: ProbeResult;
  insert?: InsertResult;
  secondProbe?: ProbeResult;
};

function fakeClient(opts: FakeOpts) {
  const probeMaybeSingle = vi.fn().mockResolvedValueOnce(opts.probe);
  if (opts.secondProbe) {
    probeMaybeSingle.mockResolvedValueOnce(opts.secondProbe);
  }
  const insertMaybeSingle = vi
    .fn()
    .mockResolvedValue(opts.insert ?? { data: { id: "wi-new" }, error: null });

  const probeChain = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    maybeSingle: probeMaybeSingle,
  };
  const insertChain = {
    insert: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    maybeSingle: insertMaybeSingle,
  };

  let probeCallIndex = 0;
  const from = vi.fn(() => {
    // The helper does: probe, then insert (which on conflict does another
    // probe). Alternate the chains accordingly.
    probeCallIndex += 1;
    if (probeCallIndex === 2) return insertChain;
    return probeChain;
  });
  return {
    client: { from },
    probeChain,
    insertChain,
  };
}

const baseOpts = {
  kind: "operator_dispatch" as WorkItemKind,
  payload: { instruction: "draft" },
  idempotencyKey: "op-disp:pipe-1:configuration:kickoff",
  createdBy: "test-suite",
};

beforeEach(() => {
  createAdminClient.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("enqueueWorkItem", () => {
  it("inserts a new row and returns the id with duplicate:false", async () => {
    const fake = fakeClient({
      probe: { data: null, error: null },
      insert: { data: { id: "wi-123" }, error: null },
    });
    createAdminClient.mockReturnValue(fake.client);

    const out = await enqueueWorkItem({
      ...baseOpts,
      pipelineId: "pipe-1",
      creativeId: "cre-1",
      briefId: "brief-1",
      parentWorkItemId: "wi-parent",
    });

    expect(out).toEqual({ id: "wi-123", duplicate: false });
    // The probe path was hit once with the right idempotency_key.
    expect(fake.probeChain.eq).toHaveBeenCalledWith("idempotency_key", baseOpts.idempotencyKey);
    // The insert payload carries the scoping FKs we passed.
    expect(fake.insertChain.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "operator_dispatch",
        status: "queued",
        idempotency_key: baseOpts.idempotencyKey,
        created_by: "test-suite",
        pipeline_id: "pipe-1",
        creative_id: "cre-1",
        brief_id: "brief-1",
        parent_work_item_id: "wi-parent",
        payload: { instruction: "draft" },
      }),
    );
  });

  it("returns the existing row when the probe hits a duplicate idempotency_key", async () => {
    const fake = fakeClient({
      probe: { data: { id: "wi-existing" }, error: null },
    });
    createAdminClient.mockReturnValue(fake.client);

    const out = await enqueueWorkItem(baseOpts);

    expect(out).toEqual({ id: "wi-existing", duplicate: true });
    // The insert was never attempted -- a dedup short-circuits before write.
    expect(fake.insertChain.insert).not.toHaveBeenCalled();
  });

  it("resolves to duplicate when a unique-conflict races past the probe", async () => {
    const fake = fakeClient({
      probe: { data: null, error: null },
      insert: {
        data: null,
        error: {
          code: "23505",
          message: 'duplicate key value violates unique constraint "work_item_idempotency_key_key"',
        },
      },
      secondProbe: { data: { id: "wi-race-winner" }, error: null },
    });
    createAdminClient.mockReturnValue(fake.client);

    const out = await enqueueWorkItem(baseOpts);

    expect(out).toEqual({ id: "wi-race-winner", duplicate: true });
  });

  it("throws on a non-conflict insert error so the caller can 5xx", async () => {
    const fake = fakeClient({
      probe: { data: null, error: null },
      insert: {
        data: null,
        error: { code: "23502", message: "null value in column 'kind'" },
      },
    });
    createAdminClient.mockReturnValue(fake.client);

    await expect(enqueueWorkItem(baseOpts)).rejects.toThrow(/work_item insert failed/);
  });

  it("throws when the conflict winner is unreadable (real consistency error)", async () => {
    const fake = fakeClient({
      probe: { data: null, error: null },
      insert: {
        data: null,
        error: {
          code: "23505",
          message: "duplicate key value violates unique constraint on idempotency_key",
        },
      },
      secondProbe: {
        data: null,
        error: { code: "PGRST500", message: "boom" },
      },
    });
    createAdminClient.mockReturnValue(fake.client);

    await expect(enqueueWorkItem(baseOpts)).rejects.toThrow(
      /work_item insert conflicted on idempotency_key/,
    );
  });

  it("throws on a probe error other than PGRST116 (no-rows)", async () => {
    const fake = fakeClient({
      probe: {
        data: null,
        error: { code: "PGRST500", message: "boom" },
      },
    });
    createAdminClient.mockReturnValue(fake.client);

    await expect(enqueueWorkItem(baseOpts)).rejects.toThrow(/work_item probe failed/);
  });

  it("treats PGRST116 (no rows) as a clean probe miss", async () => {
    const fake = fakeClient({
      probe: { data: null, error: { code: "PGRST116", message: "no rows" } },
      insert: { data: { id: "wi-fresh" }, error: null },
    });
    createAdminClient.mockReturnValue(fake.client);

    const out = await enqueueWorkItem(baseOpts);
    expect(out).toEqual({ id: "wi-fresh", duplicate: false });
  });

  it("throws when the insert succeeds but no id is returned (RLS misconfig)", async () => {
    const fake = fakeClient({
      probe: { data: null, error: null },
      insert: { data: null, error: null },
    });
    createAdminClient.mockReturnValue(fake.client);

    await expect(enqueueWorkItem(baseOpts)).rejects.toThrow(
      /work_item insert succeeded but returned no id/,
    );
  });
});
