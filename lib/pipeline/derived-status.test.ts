import { beforeEach, describe, expect, it, vi } from "vitest";

import { mockClient } from "@/tests/unit/helpers/api-mock";

// `lib/pipeline/derived-status` is server-only; neutralise the import marker
// so the node test project can load the module under test.
vi.mock("server-only", () => ({}));

import {
  getDerivedStatus,
  hydratePipelineStatus,
  hydratePipelineStatusMany,
} from "./derived-status";

const PIPELINE_ID = "11111111-1111-4111-8111-111111111111";

describe("getDerivedStatus", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the RPC result when configured", async () => {
    const sb = mockClient({
      rpc: { compute_pipeline_status: { data: "ideation", error: null } },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await getDerivedStatus(sb as unknown as any, PIPELINE_ID);
    expect(result).toBe("ideation");
  });

  it("returns null when the RPC produces no data", async () => {
    const sb = mockClient({});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await getDerivedStatus(sb as unknown as any, PIPELINE_ID);
    expect(result).toBeNull();
  });

  it("throws on RPC error so callers surface a 5xx instead of a silent default", async () => {
    const sb = mockClient({
      rpc: { compute_pipeline_status: { data: null, error: { message: "boom" } } },
    });
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      getDerivedStatus(sb as unknown as any, PIPELINE_ID),
    ).rejects.toThrow(/boom/);
  });
});

describe("hydratePipelineStatus", () => {
  it("merges the derived status onto the row", async () => {
    const sb = mockClient({
      rpc: { compute_pipeline_status: { data: "generation", error: null } },
    });
    const row = { id: PIPELINE_ID, format_choice: "image" as const };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const enriched = await hydratePipelineStatus(sb as unknown as any, row);
    expect(enriched).toEqual({ id: PIPELINE_ID, format_choice: "image", status: "generation" });
  });

  it("defaults to 'configuration' when the reducer returns null", async () => {
    const sb = mockClient({});
    const row = { id: PIPELINE_ID, format_choice: "image" as const };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const enriched = await hydratePipelineStatus(sb as unknown as any, row);
    expect(enriched.status).toBe("configuration");
  });
});

describe("hydratePipelineStatusMany", () => {
  it("enriches every row in the input array", async () => {
    let i = 0;
    const stages = ["ideation", "review", "generation"];
    const sb = mockClient({});
    (sb as unknown as { rpc: ReturnType<typeof vi.fn> }).rpc = vi.fn(() =>
      Promise.resolve({ data: stages[i++], error: null }),
    );
    const rows = [
      { id: "a", format_choice: "image" as const },
      { id: "b", format_choice: "video" as const },
      { id: "c", format_choice: "both" as const },
    ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const enriched = await hydratePipelineStatusMany(sb as unknown as any, rows);
    expect(enriched.map((r) => r.status)).toEqual(["ideation", "review", "generation"]);
  });
});
