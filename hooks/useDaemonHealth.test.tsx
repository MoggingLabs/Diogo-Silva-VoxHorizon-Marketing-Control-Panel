/**
 * Tests for `useDaemonHealth` (silent-failure PR-2a).
 *
 * Covers:
 *  - SSR hydration via `initialConsumer` (no fetch fired);
 *  - client-side fetch when no seed;
 *  - realtime consumer-row UPDATE triggers refetch;
 *  - periodic re-derivation of `freshness` from `last_seen_at` (stale path);
 *  - error surfacing.
 */
import { act, render, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mockRealtimeStream } from "@/tests/unit/helpers/realtime-mock";
import type { WorkItemConsumer } from "@/lib/work-queue/types";

const realtime = mockRealtimeStream();
vi.mock("@/hooks/useRealtimeStream", () => ({
  useRealtimeStream: (listeners: unknown) =>
    realtime.register(listeners as Parameters<typeof realtime.register>[0]),
}));

import { useDaemonHealth } from "./useDaemonHealth";

function consumer(over: Partial<WorkItemConsumer> = {}): WorkItemConsumer {
  return {
    id: "operator-daemon-1",
    kind: "operator_dispatch",
    status: "live",
    startup_check: { auth: "ok", hermes: "ok" },
    last_seen_at: new Date().toISOString(),
    image_tag: "operator:1.2.3",
    hostname: "operator-1",
    created_at: "2026-05-26T11:00:00Z",
    updated_at: new Date().toISOString(),
    ...over,
  };
}

function Probe({
  initialConsumer,
  url,
}: {
  initialConsumer?: WorkItemConsumer | null;
  url?: string;
}) {
  const {
    consumer: c,
    freshness,
    isLoading,
    error,
  } = useDaemonHealth({
    initialConsumer,
    url,
    tickIntervalMs: 50,
  });
  return (
    <div>
      <span data-testid="freshness">{freshness}</span>
      <span data-testid="id">{c?.id ?? "none"}</span>
      <span data-testid="status">{c?.status ?? "none"}</span>
      <span data-testid="loading">{isLoading ? "yes" : "no"}</span>
      <span data-testid="error">{error ?? "none"}</span>
    </div>
  );
}

beforeEach(() => {
  realtime.reset();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("useDaemonHealth", () => {
  it("hydrates synchronously from initialConsumer (no fetch)", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { getByTestId } = render(<Probe initialConsumer={consumer({ status: "live" })} />);
    expect(getByTestId("freshness").textContent).toBe("live");
    expect(getByTestId("status").textContent).toBe("live");
    expect(getByTestId("loading").textContent).toBe("no");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("renders freshness='down' when initialConsumer is null", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { getByTestId } = render(<Probe initialConsumer={null} />);
    expect(getByTestId("freshness").textContent).toBe("down");
    expect(getByTestId("status").textContent).toBe("none");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("fetches on mount with no seed", async () => {
    const c = consumer({ status: "live" });
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      json: async () => ({ consumer: c, freshness: "live" }),
    }));
    vi.stubGlobal("fetch", fetchSpy);
    const { getByTestId } = render(<Probe url="/test/daemon-health" />);
    expect(getByTestId("loading").textContent).toBe("yes");
    await waitFor(() => {
      expect(getByTestId("freshness").textContent).toBe("live");
    });
    expect(fetchSpy).toHaveBeenCalledWith(
      "/test/daemon-health",
      expect.objectContaining({ cache: "no-store" }),
    );
  });

  it("re-fetches when a realtime consumer event arrives", async () => {
    // Single mutable state so a redundant fetch (from the realtime-mock
    // appending listeners on every render) keeps returning the LATEST
    // intended response instead of `undefined`.
    let next = consumer({ status: "live" });
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      json: async () => ({ consumer: next, freshness: next.status === "down" ? "down" : "live" }),
    }));
    vi.stubGlobal("fetch", fetchSpy);

    const { getByTestId } = render(<Probe url="/test/daemon-health" />);
    await waitFor(() => expect(getByTestId("status").textContent).toBe("live"));

    next = consumer({ status: "down", startup_check: { auth: "expired" } });
    await act(async () => {
      realtime.emit("work_item_consumers", "UPDATE", { new: { status: "down" } });
      await new Promise((r) => setTimeout(r, 0));
    });
    await waitFor(() => expect(getByTestId("status").textContent).toBe("down"));
    await waitFor(() => expect(getByTestId("freshness").textContent).toBe("down"));
  });

  it("re-derives freshness from last_seen_at on the periodic tick", async () => {
    // last_seen_at is 5min old -> stale.
    const oldConsumer = consumer({
      status: "live",
      last_seen_at: new Date(Date.now() - 5 * 60_000).toISOString(),
    });
    const { getByTestId } = render(<Probe initialConsumer={oldConsumer} />);
    // SSR-seed compute path already runs once on render -> immediately stale.
    expect(getByTestId("freshness").textContent).toBe("stale");
    // Wait one tick (50ms) — value should still be stale.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 70));
    });
    expect(getByTestId("freshness").textContent).toBe("stale");
  });

  it("surfaces a non-OK fetch as an error", async () => {
    const fetchSpy = vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) }));
    vi.stubGlobal("fetch", fetchSpy);
    const { getByTestId } = render(<Probe url="/test/daemon-health" />);
    await waitFor(() => {
      expect(getByTestId("error").textContent).toContain("503");
    });
  });

  it("surfaces a network error", async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error("offline");
    });
    vi.stubGlobal("fetch", fetchSpy);
    const { getByTestId } = render(<Probe url="/test/daemon-health" />);
    await waitFor(() => {
      expect(getByTestId("error").textContent).toBe("offline");
    });
  });
});
