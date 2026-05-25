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
});
