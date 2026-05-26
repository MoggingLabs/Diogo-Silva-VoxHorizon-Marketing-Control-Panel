/**
 * Tests for `lib/operator/console.ts` getOperatorRuns: filters to active,
 * operator-driven runs, resolves client names, and seeds recent events.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { mockClient } from "@/tests/unit/helpers/api-mock";
import { type SupabaseClientMock } from "@/tests/unit/helpers/supabase-mock";

let currentSupabase: SupabaseClientMock = mockClient();

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => currentSupabase,
}));

import { getOperatorRuns } from "./console";

describe("getOperatorRuns", () => {
  beforeEach(() => {
    currentSupabase = mockClient();
  });

  it("returns [] when there are no active pipelines", async () => {
    currentSupabase = mockClient({
      pipelines: { select: { data: [], error: null } },
    });
    expect(await getOperatorRuns()).toEqual([]);
  });

  it("returns [] when the pipelines query yields null data", async () => {
    currentSupabase = mockClient({
      pipelines: { select: { data: null, error: null } },
    });
    expect(await getOperatorRuns()).toEqual([]);
  });

  it("tolerates a null clients lookup and an unresolved client name", async () => {
    currentSupabase = mockClient({
      pipelines: {
        select: {
          data: [
            {
              id: "op1",
              status: "generation",
              format_choice: "image",
              client_id: "missing", // present -> triggers the lookup
              config_draft: { operator_driven: true },
              created_at: "2026-05-26T00:00:00Z",
              updated_at: "2026-05-26T01:00:00Z",
            },
          ],
          error: null,
        },
      },
      // null clients data -> the `clients ?? []` guard; name stays unresolved.
      clients: { select: { data: null, error: null } },
      pipeline_events: { select: { data: [], error: null } },
    });
    const runs = await getOperatorRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]!.clientName).toBeNull();
  });

  it("keeps only operator-driven runs and drops manual ones", async () => {
    currentSupabase = mockClient({
      pipelines: {
        select: {
          data: [
            {
              id: "op1",
              status: "generation",
              format_choice: "image",
              client_id: "c1",
              config_draft: { operator_driven: true },
              created_at: "2026-05-26T00:00:00Z",
              updated_at: "2026-05-26T01:00:00Z",
            },
            {
              id: "manual1",
              status: "ideation",
              format_choice: "image",
              client_id: null,
              config_draft: {},
              created_at: "2026-05-26T00:00:00Z",
              updated_at: "2026-05-26T00:30:00Z",
            },
          ],
          error: null,
        },
      },
      clients: { select: { data: [{ id: "c1", name: "Acme" }], error: null } },
      pipeline_events: {
        select: {
          data: [
            {
              id: "e1",
              pipeline_id: "op1",
              kind: "stage_advanced",
              stage: "generation",
              payload: {},
              created_at: "2026-05-26T00:45:00Z",
            },
          ],
          error: null,
        },
      },
    });

    const runs = await getOperatorRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]!.id).toBe("op1");
    expect(runs[0]!.clientName).toBe("Acme");
    expect(runs[0]!.events).toHaveLength(1);
  });

  it("skips the client lookup when no run has a client_id and tolerates null events", async () => {
    currentSupabase = mockClient({
      pipelines: {
        select: {
          data: [
            {
              id: "op1",
              status: "review",
              format_choice: "image",
              client_id: null, // every run null -> clientIds empty -> skip lookup
              config_draft: { operator_driven: true },
              created_at: "2026-05-26T00:00:00Z",
              updated_at: "2026-05-26T01:00:00Z",
            },
          ],
          error: null,
        },
      },
      // null events data -> the `events ?? []` guard kicks in.
      pipeline_events: { select: { data: null, error: null } },
    });

    const runs = await getOperatorRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]!.clientName).toBeNull();
    expect(runs[0]!.events).toEqual([]);
  });

  it("caps the seeded events per run at EVENTS_PER_RUN", async () => {
    // 35 events for one run -> exercises the `< EVENTS_PER_RUN` cap (the cap is
    // 30), so the run keeps only 30.
    const manyEvents = Array.from({ length: 35 }, (_, i) => ({
      id: `e${i}`,
      pipeline_id: "op1",
      kind: "task_done",
      stage: "generation",
      payload: {},
      created_at: `2026-05-26T00:${String(i).padStart(2, "0")}:00Z`,
    }));
    currentSupabase = mockClient({
      pipelines: {
        select: {
          data: [
            {
              id: "op1",
              status: "generation",
              format_choice: "image",
              client_id: "c1",
              config_draft: { operator_driven: true },
              created_at: "2026-05-26T00:00:00Z",
              updated_at: "2026-05-26T01:00:00Z",
            },
          ],
          error: null,
        },
      },
      clients: { select: { data: [{ id: "c1", name: "Acme" }], error: null } },
      pipeline_events: { select: { data: manyEvents, error: null } },
    });

    const runs = await getOperatorRuns();
    expect(runs[0]!.events).toHaveLength(30);
  });

  it("surfaces the active work_item status as dispatchStatus (silent-failure PR-2a)", async () => {
    currentSupabase = mockClient({
      pipelines: {
        select: {
          data: [
            {
              id: "op1",
              status: "generation",
              format_choice: "image",
              client_id: "c1",
              config_draft: { operator_driven: true },
              created_at: "2026-05-26T00:00:00Z",
              updated_at: "2026-05-26T01:00:00Z",
            },
          ],
          error: null,
        },
      },
      clients: { select: { data: [{ id: "c1", name: "Acme" }], error: null } },
      pipeline_events: { select: { data: [], error: null } },
      work_item: {
        select: {
          data: [
            // Newest-first; the first row dominates UNLESS an earlier active
            // row overrides. Here the newest row is also active, so use it.
            {
              pipeline_id: "op1",
              status: "running",
              created_at: "2026-05-26T01:00:00Z",
            },
          ],
          error: null,
        },
      },
    });
    const runs = await getOperatorRuns();
    expect(runs[0]!.dispatchStatus).toBe("running");
  });

  it("prefers an active work_item over a newer terminal one", async () => {
    currentSupabase = mockClient({
      pipelines: {
        select: {
          data: [
            {
              id: "op1",
              status: "generation",
              format_choice: "image",
              client_id: null,
              config_draft: { operator_driven: true },
              created_at: "2026-05-26T00:00:00Z",
              updated_at: "2026-05-26T01:00:00Z",
            },
          ],
          error: null,
        },
      },
      pipeline_events: { select: { data: [], error: null } },
      work_item: {
        select: {
          data: [
            // Newest row: terminal. We expect the loader to keep this as the
            // initial pick, but then upgrade to the active row below.
            { pipeline_id: "op1", status: "completed", created_at: "2026-05-26T01:00:00Z" },
            // Older row that is still active -> wins.
            { pipeline_id: "op1", status: "queued", created_at: "2026-05-26T00:30:00Z" },
          ],
          error: null,
        },
      },
    });
    const runs = await getOperatorRuns();
    expect(runs[0]!.dispatchStatus).toBe("queued");
  });

  it("returns dispatchStatus=null when no work_item exists for the pipeline", async () => {
    currentSupabase = mockClient({
      pipelines: {
        select: {
          data: [
            {
              id: "op1",
              status: "configuration",
              format_choice: "image",
              client_id: null,
              config_draft: { operator_driven: true },
              created_at: "2026-05-26T00:00:00Z",
              updated_at: "2026-05-26T01:00:00Z",
            },
          ],
          error: null,
        },
      },
      pipeline_events: { select: { data: [], error: null } },
      work_item: { select: { data: [], error: null } },
    });
    const runs = await getOperatorRuns();
    expect(runs[0]!.dispatchStatus).toBeNull();
  });
});
