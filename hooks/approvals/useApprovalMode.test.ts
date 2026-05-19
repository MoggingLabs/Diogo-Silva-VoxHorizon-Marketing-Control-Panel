/**
 * Tests for the live approval-mode hook.
 *
 * The hook owns a Supabase Realtime channel, a debounced re-fetch queue,
 * and a 30s "force render" tick for the TTL countdown. We mock the
 * Supabase browser client + ``fetch`` so the hook runs end-to-end without
 * a real Postgres connection.
 */
import { renderHook, waitFor, act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const channelMock = {
  on: vi.fn(),
  subscribe: vi.fn(),
};
const supabaseMock = {
  channel: vi.fn(() => channelMock),
  removeChannel: vi.fn(async () => undefined),
};

vi.mock("@/lib/supabase/browser", () => ({
  createClient: () => supabaseMock,
}));

const realtimeQueueMock = {
  queue: vi.fn(),
  dispose: vi.fn(),
};
vi.mock("@/lib/realtime-queue", () => ({
  createRealtimeQueue: () => realtimeQueueMock,
}));

import { useApprovalMode } from "./useApprovalMode";

function chainable() {
  channelMock.on.mockImplementation(() => channelMock);
  channelMock.subscribe.mockImplementation(() => channelMock);
}

describe("useApprovalMode", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    chainable();
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            mode: "ASK",
            expires_at: null,
            set_by: "dashboard",
            set_at: "2026-05-19T00:00:00Z",
            note: null,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    ) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.clearAllMocks();
  });

  it("fetches the singleton on mount", async () => {
    const { result } = renderHook(() => useApprovalMode());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.state?.mode).toBe("ASK");
    expect(result.current.error).toBeNull();
  });

  it("subscribes to the approval_mode realtime channel", async () => {
    renderHook(() => useApprovalMode());
    await waitFor(() => expect(supabaseMock.channel).toHaveBeenCalled());
    expect(supabaseMock.channel).toHaveBeenCalledWith("approval-mode-singleton");
    expect(channelMock.on).toHaveBeenCalledWith(
      "postgres_changes",
      expect.objectContaining({ event: "*", table: "approval_mode" }),
      expect.any(Function),
    );
    expect(channelMock.subscribe).toHaveBeenCalled();
  });

  it("surfaces a fetch error", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response("boom", { status: 500 })) as unknown as typeof fetch;
    const { result } = renderHook(() => useApprovalMode());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe("HTTP 500");
  });

  it("surfaces a thrown fetch error", async () => {
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(new Error("network down")) as unknown as typeof fetch;
    const { result } = renderHook(() => useApprovalMode());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toContain("network down");
  });

  it("calls the realtime callback through the queue on change", async () => {
    let captured: ((p: unknown) => void) | undefined;
    channelMock.on.mockImplementation((_event: string, _filter: unknown, cb: unknown) => {
      captured = cb as (p: unknown) => void;
      return channelMock;
    });
    renderHook(() => useApprovalMode());
    await waitFor(() => expect(channelMock.subscribe).toHaveBeenCalled());

    expect(captured).toBeDefined();
    captured!({ eventType: "UPDATE" });
    expect(realtimeQueueMock.queue).toHaveBeenCalledWith("refresh", expect.any(Function));
  });

  it("disposes the queue + removes the channel on unmount", async () => {
    const { unmount } = renderHook(() => useApprovalMode());
    await waitFor(() => expect(channelMock.subscribe).toHaveBeenCalled());
    unmount();
    expect(realtimeQueueMock.dispose).toHaveBeenCalled();
    expect(supabaseMock.removeChannel).toHaveBeenCalled();
  });

  it("re-fetches when refresh() is called", async () => {
    const fetchSpy = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            mode: "HALT",
            expires_at: null,
            set_by: "dashboard",
            set_at: "x",
            note: null,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const { result } = renderHook(() => useApprovalMode());
    await waitFor(() => expect(result.current.loading).toBe(false));
    const initialCalls = fetchSpy.mock.calls.length;
    await act(async () => {
      await result.current.refresh();
    });
    expect(fetchSpy.mock.calls.length).toBeGreaterThan(initialCalls);
  });

  it("ticks state every 30s to refresh derived TTL labels", async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useApprovalMode());
    await vi.advanceTimersByTimeAsync(0);
    // Initial fetch resolves.
    await vi.runOnlyPendingTimersAsync();
    const firstState = result.current.state;
    await act(async () => {
      vi.advanceTimersByTime(31_000);
    });
    // The reference identity must change to force consumers to re-render.
    expect(result.current.state).not.toBe(firstState);
    vi.useRealTimers();
  });

  it("uses a custom fetchUrl when supplied", async () => {
    const fetchSpy = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            mode: "ASK",
            expires_at: null,
            set_by: null,
            set_at: "x",
            note: null,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    renderHook(() => useApprovalMode({ fetchUrl: "/custom/url" }));
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    const calls = fetchSpy.mock.calls as ReadonlyArray<readonly unknown[]>;
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0]![0]).toBe("/custom/url");
  });
});
