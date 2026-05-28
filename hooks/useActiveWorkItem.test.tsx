/**
 * Tests for `useActiveWorkItem` (silent-failure PR-2a + PR-5).
 *
 * Covers:
 *  - SSR hydration from `initialState` (no fetch fired);
 *  - client-side initial fetch when no seed;
 *  - realtime work_item INSERT/UPDATE triggers refetch;
 *  - 5xx response surfaces an error.
 *  - PR-5 gate: seeded with NO active work_item -> NO fetch + NO realtime
 *    listener registered (the anti-stall gate); seeded WITH an active
 *    work_item -> the full `*` listener opens and stays primed without a fetch.
 */
import { act, render, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mockRealtimeStream } from "@/tests/unit/helpers/realtime-mock";
import type { PipelineDispatchState } from "@/lib/work-queue/types";

const realtime = mockRealtimeStream();

vi.mock("@/hooks/useRealtimeStream", () => ({
  useRealtimeStream: (listeners: unknown) =>
    realtime.register(listeners as Parameters<typeof realtime.register>[0]),
}));

import { useActiveWorkItem } from "./useActiveWorkItem";

const INITIAL_STATE: PipelineDispatchState = {
  pipelineId: "p1",
  derivedStatus: "configuration",
  activeWorkItem: {
    id: "wi-1",
    kind: "operator_dispatch",
    pipeline_id: "p1",
    creative_id: null,
    brief_id: null,
    status: "running",
    attempt: 1,
    claim_token: "tok",
    claimed_by: "operator-daemon-1",
    claimed_at: "2026-05-26T12:00:00Z",
    heartbeat_at: "2026-05-26T12:00:00Z",
    completed_at: null,
    error_kind: null,
    error_detail: null,
    payload: {},
    result: null,
    idempotency_key: "op-disp:p1:configuration:kickoff",
    parent_work_item_id: null,
    created_by: "api/pipelines/operator",
    next_attempt_at: "2026-05-26T12:00:00Z",
    created_at: "2026-05-26T11:55:00Z",
    updated_at: "2026-05-26T12:00:00Z",
  },
  recentEvents: [],
  operatorDaemon: null,
};

const REFRESHED_STATE: PipelineDispatchState = {
  ...INITIAL_STATE,
  activeWorkItem: { ...INITIAL_STATE.activeWorkItem!, status: "completed", id: "wi-2" },
};

// PR-5: an idle seed -- the dispatcher has no active work_item. This is the
// happy-path shape the ideation/review/generation slots receive.
const IDLE_STATE: PipelineDispatchState = {
  pipelineId: "p1",
  derivedStatus: "ideation",
  activeWorkItem: null,
  recentEvents: [],
  operatorDaemon: null,
};

/** Listeners the hook registered for the `work_item` table. */
function workItemListeners() {
  return realtime.listeners.filter((l) => l.table === "work_item");
}

function Probe({ initialState, url }: { initialState?: PipelineDispatchState; url?: string }) {
  const { activeWorkItem, recentEvents, derivedStatus, isLoading, error } = useActiveWorkItem(
    "p1",
    { initialState, url },
  );
  return (
    <div>
      <span data-testid="status">{activeWorkItem?.status ?? "none"}</span>
      <span data-testid="id">{activeWorkItem?.id ?? "none"}</span>
      <span data-testid="events-len">{recentEvents.length}</span>
      <span data-testid="derived">{derivedStatus ?? "none"}</span>
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

describe("useActiveWorkItem", () => {
  it("hydrates synchronously from initialState (no fetch fired)", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { getByTestId } = render(<Probe initialState={INITIAL_STATE} />);
    expect(getByTestId("status").textContent).toBe("running");
    expect(getByTestId("derived").textContent).toBe("configuration");
    expect(getByTestId("loading").textContent).toBe("no");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("opens the full '*' realtime listener when seeded WITH an active work_item", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    render(<Probe initialState={INITIAL_STATE} />);
    const wi = workItemListeners();
    expect(wi).toHaveLength(1);
    expect(wi[0]!.event).toBe("*");
    // Primed from the seed, no fetch on mount.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("PR-5 gate: seeded IDLE (no active work_item) fires NO fetch and opens NO realtime listener", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { getByTestId } = render(<Probe initialState={IDLE_STATE} />);

    // Primed from the idle seed: no active work_item, not loading.
    expect(getByTestId("status").textContent).toBe("none");
    expect(getByTestId("loading").textContent).toBe("no");

    // The anti-stall gate: no work-state fetch on mount...
    expect(fetchSpy).not.toHaveBeenCalled();
    // ...and NO realtime listener registered for work_item (no channel opens).
    expect(workItemListeners()).toHaveLength(0);
  });

  it("fetches on mount when no initialState is provided", async () => {
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      json: async () => REFRESHED_STATE,
    }));
    vi.stubGlobal("fetch", fetchSpy);

    const { getByTestId } = render(<Probe url="/test/work-state" />);
    expect(getByTestId("loading").textContent).toBe("yes");
    await waitFor(() => {
      expect(getByTestId("status").textContent).toBe("completed");
    });
    expect(fetchSpy).toHaveBeenCalledWith(
      "/test/work-state",
      expect.objectContaining({ cache: "no-store" }),
    );
  });

  it("re-fetches on a realtime work_item event", async () => {
    let next: PipelineDispatchState = INITIAL_STATE;
    const fetchSpy = vi.fn(async () => ({ ok: true, json: async () => next }));
    vi.stubGlobal("fetch", fetchSpy);

    const { getByTestId } = render(<Probe initialState={INITIAL_STATE} />);
    expect(getByTestId("status").textContent).toBe("running");

    next = REFRESHED_STATE;
    await act(async () => {
      realtime.emit("work_item", "UPDATE", { new: { id: "wi-2" } });
      await new Promise((r) => setTimeout(r, 0));
    });
    await waitFor(() => {
      expect(getByTestId("status").textContent).toBe("completed");
    });
  });

  it("surfaces a newly-appeared work_item via a realtime INSERT (active stream)", async () => {
    // The full `*` listener covers INSERTs too: an INSERT triggers a refetch
    // that surfaces the new row. We start from a non-idle seed so the stream is
    // open (the idle gate is exercised separately above).
    let next: PipelineDispatchState = INITIAL_STATE;
    const fetchSpy = vi.fn(async () => ({ ok: true, json: async () => next }));
    vi.stubGlobal("fetch", fetchSpy);

    const { getByTestId } = render(<Probe initialState={INITIAL_STATE} />);
    expect(getByTestId("id").textContent).toBe("wi-1");
    // The stream is open and the listener accepts INSERT (event === "*").
    expect(workItemListeners()[0]!.event).toBe("*");

    next = REFRESHED_STATE;
    await act(async () => {
      realtime.emit("work_item", "INSERT", { new: { id: "wi-2" } });
      await new Promise((r) => setTimeout(r, 0));
    });
    await waitFor(() => {
      expect(getByTestId("id").textContent).toBe("wi-2");
    });
    expect(fetchSpy).toHaveBeenCalled();
  });

  it("surfaces a non-OK response as an error", async () => {
    const fetchSpy = vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }));
    vi.stubGlobal("fetch", fetchSpy);
    const { getByTestId } = render(<Probe url="/test/work-state" />);
    await waitFor(() => {
      expect(getByTestId("error").textContent).toContain("500");
    });
  });

  it("surfaces a network error", async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error("network blew up");
    });
    vi.stubGlobal("fetch", fetchSpy);
    const { getByTestId } = render(<Probe url="/test/work-state" />);
    await waitFor(() => {
      expect(getByTestId("error").textContent).toBe("network blew up");
    });
  });
});
