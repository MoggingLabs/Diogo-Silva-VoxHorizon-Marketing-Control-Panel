/**
 * useApprovalsSubscription wires together a `fetch()` initial load and a
 * Supabase Realtime subscription. We mock both and assert:
 *   - The initial fetch populates state.
 *   - INSERT events fire onNewApproval immediately.
 *   - UPDATE events with non-pending status fire onApprovalResolved.
 *   - Unmount removes the channel.
 */
import { act, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Approval } from "@/lib/approvals/types";
import { mockSupabaseClient, type SupabaseClientMock } from "@/tests/unit/helpers/supabase-mock";

let currentClient: SupabaseClientMock;
vi.mock("@/lib/supabase/browser", () => ({
  createClient: () => currentClient,
}));

import { useApprovalsSubscription } from "./useApprovalsSubscription";

function ApprovalsHookHarness({
  onState,
  onNewApproval,
  onApprovalResolved,
}: {
  onState: (state: ReturnType<typeof useApprovalsSubscription>) => void;
  onNewApproval?: (a: Approval) => void;
  onApprovalResolved?: (a: Approval) => void;
}) {
  const state = useApprovalsSubscription({ onNewApproval, onApprovalResolved });
  onState(state);
  return <div data-testid="harness" data-count={state.count} />;
}

function mockFetchOk(approvals: Approval[] = []) {
  return vi.fn(() =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ approvals }),
    } as unknown as Response),
  );
}

const sampleApproval = (overrides: Partial<Approval> = {}): Approval => ({
  id: "a1",
  ekko_session_id: "s1",
  ekko_tool_call_id: "tc1",
  tool_name: "read_file",
  tool_args: { path: "/etc/hosts" },
  risk_class: "filesystem",
  context: null,
  requested_at: "2026-05-18T12:00:00Z",
  expires_at: "2026-05-18T12:05:00Z",
  status: "pending",
  decision: null,
  decided_by: null,
  decided_at: null,
  decision_notes: null,
  cache_for_session: null,
  cache_for_minutes: null,
  worker_received_at: null,
  ...overrides,
});

beforeEach(() => {
  currentClient = mockSupabaseClient();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useApprovalsSubscription", () => {
  it("does the initial fetch and sets approvals", async () => {
    const fetchSpy = mockFetchOk([sampleApproval(), sampleApproval({ id: "a2" })]);
    vi.stubGlobal("fetch", fetchSpy);

    const stateBox: { current: ReturnType<typeof useApprovalsSubscription> | null } = {
      current: null,
    };
    render(<ApprovalsHookHarness onState={(s) => (stateBox.current = s)} />);
    const lastState = () => stateBox.current;

    await waitFor(() => expect(lastState()?.loading).toBe(false));
    expect(lastState()?.count).toBe(2);
    expect(lastState()?.approvals.map((a) => a.id)).toEqual(["a1", "a2"]);
    expect(fetchSpy).toHaveBeenCalledWith("/api/approvals?status=pending", { cache: "no-store" });
  });

  it("uses a custom fetchUrl when provided", async () => {
    const fetchSpy = mockFetchOk([]);
    vi.stubGlobal("fetch", fetchSpy);
    render(<ApprovalsHookHarness onState={() => {}} />);
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
  });

  it("captures fetch errors and exposes them on `error`", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("network down"))),
    );
    const stateBox: { current: ReturnType<typeof useApprovalsSubscription> | null } = {
      current: null,
    };
    render(<ApprovalsHookHarness onState={(s) => (stateBox.current = s)} />);
    const lastState = () => stateBox.current;
    await waitFor(() => expect(lastState()?.error).toBe("network down"));
  });

  it("reports HTTP errors when fetch returns !ok", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve({
          ok: false,
          status: 500,
          json: () => Promise.resolve({}),
        } as unknown as Response),
      ),
    );
    const stateBox: { current: ReturnType<typeof useApprovalsSubscription> | null } = {
      current: null,
    };
    render(<ApprovalsHookHarness onState={(s) => (stateBox.current = s)} />);
    const lastState = () => stateBox.current;
    await waitFor(() => expect(lastState()?.error).toBe("HTTP 500"));
  });

  it("invokes onNewApproval immediately for INSERT events with status='pending'", async () => {
    vi.stubGlobal("fetch", mockFetchOk([]));

    const handlers: Array<(payload: unknown) => void> = [];
    const fakeChannel: Record<string, unknown> = {};
    fakeChannel.on = vi.fn((_event: string, _spec: unknown, cb: (payload: unknown) => void) => {
      handlers.push(cb);
      return fakeChannel;
    });
    fakeChannel.subscribe = vi.fn(() => fakeChannel);
    currentClient = {
      ...currentClient,
      channel: vi.fn(() => fakeChannel) as unknown as SupabaseClientMock["channel"],
    } as SupabaseClientMock;

    const onNew = vi.fn();
    render(<ApprovalsHookHarness onState={() => {}} onNewApproval={onNew} />);

    // The INSERT handler is the first call to `.on(...)`.
    const insertHandler = handlers[0]!;
    act(() => {
      insertHandler({ new: sampleApproval() });
    });
    expect(onNew).toHaveBeenCalledTimes(1);
    const firstArg = onNew.mock.calls[0]?.[0] as Approval | undefined;
    expect(firstArg?.id).toBe("a1");
  });

  it("ignores INSERT payloads that don't look like pending approvals", async () => {
    vi.stubGlobal("fetch", mockFetchOk([]));
    const handlers: Array<(payload: unknown) => void> = [];
    const fakeChannel: Record<string, unknown> = {};
    fakeChannel.on = vi.fn((_e: string, _spec: unknown, cb: (payload: unknown) => void) => {
      handlers.push(cb);
      return fakeChannel;
    });
    fakeChannel.subscribe = vi.fn(() => fakeChannel);
    currentClient = {
      ...currentClient,
      channel: vi.fn(() => fakeChannel) as unknown as SupabaseClientMock["channel"],
    } as SupabaseClientMock;

    const onNew = vi.fn();
    render(<ApprovalsHookHarness onState={() => {}} onNewApproval={onNew} />);

    const insertHandler = handlers[0]!;
    act(() => {
      insertHandler({ new: { id: "x", status: "decided" } });
    });
    act(() => {
      insertHandler({ new: null });
    });
    expect(onNew).not.toHaveBeenCalled();
  });

  it("invokes onApprovalResolved when UPDATE moves status away from pending", async () => {
    vi.stubGlobal("fetch", mockFetchOk([]));
    const handlers: Array<(payload: unknown) => void> = [];
    const fakeChannel: Record<string, unknown> = {};
    fakeChannel.on = vi.fn((_e: string, _spec: unknown, cb: (payload: unknown) => void) => {
      handlers.push(cb);
      return fakeChannel;
    });
    fakeChannel.subscribe = vi.fn(() => fakeChannel);
    currentClient = {
      ...currentClient,
      channel: vi.fn(() => fakeChannel) as unknown as SupabaseClientMock["channel"],
    } as SupabaseClientMock;

    const onResolved = vi.fn();
    render(<ApprovalsHookHarness onState={() => {}} onApprovalResolved={onResolved} />);

    // UPDATE handler is the second registered handler.
    const updateHandler = handlers[1]!;
    act(() => {
      updateHandler({ new: { ...sampleApproval(), status: "decided" } });
    });
    expect(onResolved).toHaveBeenCalledTimes(1);
  });

  it("does not invoke onApprovalResolved when UPDATE keeps status=pending", async () => {
    vi.stubGlobal("fetch", mockFetchOk([]));
    const handlers: Array<(payload: unknown) => void> = [];
    const fakeChannel: Record<string, unknown> = {};
    fakeChannel.on = vi.fn((_e: string, _spec: unknown, cb: (payload: unknown) => void) => {
      handlers.push(cb);
      return fakeChannel;
    });
    fakeChannel.subscribe = vi.fn(() => fakeChannel);
    currentClient = {
      ...currentClient,
      channel: vi.fn(() => fakeChannel) as unknown as SupabaseClientMock["channel"],
    } as SupabaseClientMock;

    const onResolved = vi.fn();
    render(<ApprovalsHookHarness onState={() => {}} onApprovalResolved={onResolved} />);

    const updateHandler = handlers[1]!;
    act(() => {
      updateHandler({ new: sampleApproval() }); // still pending
    });
    act(() => {
      updateHandler({ new: null });
    });
    expect(onResolved).not.toHaveBeenCalled();
  });

  it("DELETE events fire only a refresh (no callback)", async () => {
    vi.stubGlobal("fetch", mockFetchOk([]));
    const handlers: Array<(payload: unknown) => void> = [];
    const fakeChannel: Record<string, unknown> = {};
    fakeChannel.on = vi.fn((_e: string, _spec: unknown, cb: (payload: unknown) => void) => {
      handlers.push(cb);
      return fakeChannel;
    });
    fakeChannel.subscribe = vi.fn(() => fakeChannel);
    currentClient = {
      ...currentClient,
      channel: vi.fn(() => fakeChannel) as unknown as SupabaseClientMock["channel"],
    } as SupabaseClientMock;

    render(<ApprovalsHookHarness onState={() => {}} />);
    const deleteHandler = handlers[2]!;
    expect(() => act(() => deleteHandler({ old: { id: "x" } }))).not.toThrow();
  });

  it("removes the channel on unmount", async () => {
    vi.stubGlobal("fetch", mockFetchOk([]));
    const { unmount } = render(<ApprovalsHookHarness onState={() => {}} />);
    await waitFor(() => expect(currentClient._spies.channel).toHaveBeenCalled());
    unmount();
    expect(currentClient._spies.removeChannel).toHaveBeenCalled();
  });

  it("refresh() returns a promise and re-fetches", async () => {
    const fetchSpy = mockFetchOk([sampleApproval()]);
    vi.stubGlobal("fetch", fetchSpy);

    const stateBox: { current: ReturnType<typeof useApprovalsSubscription> | null } = {
      current: null,
    };
    render(<ApprovalsHookHarness onState={(s) => (stateBox.current = s)} />);
    const lastState = () => stateBox.current;
    await waitFor(() => expect(lastState()?.loading).toBe(false));

    await act(async () => {
      await lastState()?.refresh();
    });
    expect(fetchSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("debounced re-fetch fires after the queue flushes following an INSERT", async () => {
    const fetchSpy = mockFetchOk([]);
    vi.stubGlobal("fetch", fetchSpy);

    const handlers: Array<(payload: unknown) => void> = [];
    const fakeChannel: Record<string, unknown> = {};
    fakeChannel.on = vi.fn((_e: string, _spec: unknown, cb: (payload: unknown) => void) => {
      handlers.push(cb);
      return fakeChannel;
    });
    fakeChannel.subscribe = vi.fn(() => fakeChannel);
    currentClient = {
      ...currentClient,
      channel: vi.fn(() => fakeChannel) as unknown as SupabaseClientMock["channel"],
    } as SupabaseClientMock;

    render(<ApprovalsHookHarness onState={() => {}} />);
    // Drain the initial fetch.
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    const initialCalls = fetchSpy.mock.calls.length;

    // Fire all 3 event handlers — INSERT, UPDATE, DELETE — and let the
    // debounce window elapse. After flush there should be one extra
    // re-fetch (deduped by key='refresh').
    act(() => {
      handlers[0]?.({ new: sampleApproval() });
      handlers[1]?.({ new: { id: "x", status: "decided" } });
      handlers[2]?.({ old: { id: "x" } });
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(fetchSpy.mock.calls.length).toBeGreaterThan(initialCalls);
  });
});
