/**
 * ApprovalQueue ties the realtime hook, badge, dropdown, and modal together.
 * The tests stub `useApprovalsSubscription` so we can drive the UI without
 * a real Supabase channel — we still cover the POST + refresh flow with
 * a stubbed `fetch`.
 */
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Approval } from "@/lib/approvals/types";

type SubscribeState = {
  approvals: Approval[];
  count: number;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
};

type Callbacks = {
  onNewApproval?: (a: Approval) => void;
  onApprovalResolved?: (a: Approval) => void;
};

const subscribeState: SubscribeState = {
  approvals: [],
  count: 0,
  loading: false,
  error: null,
  refresh: vi.fn(async () => undefined),
};
const capturedCallbacks: Callbacks = {};

vi.mock("@/hooks/approvals/useApprovalsSubscription", () => ({
  useApprovalsSubscription: (opts: Callbacks) => {
    capturedCallbacks.onNewApproval = opts.onNewApproval;
    capturedCallbacks.onApprovalResolved = opts.onApprovalResolved;
    return subscribeState;
  },
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

import { ApprovalQueue } from "./ApprovalQueue";

function makeApproval(overrides: Partial<Approval> = {}): Approval {
  return {
    id: "a1",
    ekko_session_id: "s1",
    ekko_tool_call_id: "tc1",
    tool_name: "read_file",
    tool_args: { path: "/etc/hosts" },
    risk_class: "filesystem",
    context: null,
    requested_at: new Date(Date.now() - 60_000).toISOString(),
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    status: "pending",
    decision: null,
    decided_by: null,
    decided_at: null,
    decision_notes: null,
    cache_for_session: null,
    cache_for_minutes: null,
    worker_received_at: null,
    ...overrides,
  };
}

function resetState() {
  subscribeState.approvals = [];
  subscribeState.count = 0;
  subscribeState.loading = false;
  subscribeState.error = null;
  subscribeState.refresh = vi.fn(async () => undefined);
  delete capturedCallbacks.onNewApproval;
  delete capturedCallbacks.onApprovalResolved;
}

beforeEach(() => {
  resetState();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ApprovalQueue", () => {
  it("renders the toggle with no badge when count is 0", () => {
    render(<ApprovalQueue />);
    expect(screen.queryByTestId("approval-queue-badge")).not.toBeInTheDocument();
  });

  it("renders the badge with the count when there are pending approvals", () => {
    subscribeState.approvals = [makeApproval({ id: "a1" }), makeApproval({ id: "a2" })];
    subscribeState.count = 2;
    render(<ApprovalQueue />);
    expect(screen.getByTestId("approval-queue-badge").textContent).toBe("2");
  });

  it("opens the dropdown on toggle click", async () => {
    subscribeState.approvals = [makeApproval()];
    subscribeState.count = 1;
    render(<ApprovalQueue />);
    const user = userEvent.setup();
    await user.click(screen.getByTestId("approval-queue-toggle"));
    expect(screen.getByTestId("approval-queue-dropdown")).toBeInTheDocument();
  });

  it("renders empty-state when no approvals after open", async () => {
    render(<ApprovalQueue />);
    const user = userEvent.setup();
    await user.click(screen.getByTestId("approval-queue-toggle"));
    expect(screen.getByTestId("queue-empty")).toBeInTheDocument();
  });

  it("renders the loading-state placeholder when loading=true", async () => {
    subscribeState.loading = true;
    render(<ApprovalQueue />);
    const user = userEvent.setup();
    await user.click(screen.getByTestId("approval-queue-toggle"));
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });

  it("renders error message when error is non-null", async () => {
    subscribeState.error = "network down";
    render(<ApprovalQueue />);
    const user = userEvent.setup();
    await user.click(screen.getByTestId("approval-queue-toggle"));
    expect(screen.getByTestId("queue-error").textContent).toBe("network down");
  });

  it("clicking a card opens the modal", async () => {
    subscribeState.approvals = [makeApproval({ id: "x" })];
    subscribeState.count = 1;
    render(<ApprovalQueue autoOpenOnInsert={false} />);
    const user = userEvent.setup();
    await user.click(screen.getByTestId("approval-queue-toggle"));
    await user.click(screen.getByTestId("approval-card-body-x"));
    expect(screen.getByTestId("approval-modal")).toBeInTheDocument();
  });

  it("auto-opens the modal when onNewApproval fires", async () => {
    render(<ApprovalQueue autoOpenOnInsert={true} />);
    expect(screen.queryByTestId("approval-modal")).not.toBeInTheDocument();
    act(() => {
      capturedCallbacks.onNewApproval?.(makeApproval({ id: "popup" }));
    });
    expect(screen.getByTestId("approval-modal")).toBeInTheDocument();
  });

  it("does NOT auto-open when autoOpenOnInsert=false", () => {
    render(<ApprovalQueue autoOpenOnInsert={false} />);
    act(() => {
      capturedCallbacks.onNewApproval?.(makeApproval({ id: "popup" }));
    });
    expect(screen.queryByTestId("approval-modal")).not.toBeInTheDocument();
  });

  it("POSTs to /api/approvals/:id/decision when the modal Approve is clicked", async () => {
    const fetchSpy: ReturnType<typeof vi.fn> = vi.fn(() =>
      Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) } as Response),
    );
    vi.stubGlobal("fetch", fetchSpy);

    render(<ApprovalQueue />);
    act(() => {
      capturedCallbacks.onNewApproval?.(makeApproval({ id: "x", tool_args: {} }));
    });
    const user = userEvent.setup();
    await user.click(screen.getByTestId("approve-button"));
    expect(fetchSpy).toHaveBeenCalled();
    const firstCall = fetchSpy.mock.calls[0] as unknown[] | undefined;
    expect(firstCall?.[0]).toBe("/api/approvals/x/decision");
    const init = firstCall?.[1] as RequestInit | undefined;
    const body = JSON.parse((init?.body as string) ?? "{}");
    expect(body.decision).toBe("approved");
    expect(body.cache_for_session).toBe(false);
  });

  it("POSTs with cache_for_session=true when Approve+Remember is clicked", async () => {
    const fetchSpy: ReturnType<typeof vi.fn> = vi.fn(() =>
      Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) } as Response),
    );
    vi.stubGlobal("fetch", fetchSpy);

    render(<ApprovalQueue />);
    act(() => {
      capturedCallbacks.onNewApproval?.(makeApproval({ id: "remember", tool_args: {} }));
    });
    const user = userEvent.setup();
    await user.click(screen.getByTestId("approve-remember-button"));
    const firstCall = fetchSpy.mock.calls[0] as unknown[] | undefined;
    const init = firstCall?.[1] as RequestInit | undefined;
    const body = JSON.parse((init?.body as string) ?? "{}");
    expect(body.cache_for_session).toBe(true);
  });

  it("closes the modal once an approval resolves via onApprovalResolved", () => {
    render(<ApprovalQueue />);
    const a = makeApproval({ id: "resolved", tool_args: {} });
    act(() => capturedCallbacks.onNewApproval?.(a));
    expect(screen.getByTestId("approval-modal")).toBeInTheDocument();
    act(() => capturedCallbacks.onApprovalResolved?.({ ...a, status: "decided" }));
    // The modal disappears because `modalOpen` flips to false.
    expect(screen.queryByTestId("approval-modal")).not.toBeInTheDocument();
  });

  it("does not close the modal when a different approval resolves", () => {
    render(<ApprovalQueue />);
    const active = makeApproval({ id: "active" });
    act(() => capturedCallbacks.onNewApproval?.(active));
    expect(screen.getByTestId("approval-modal")).toBeInTheDocument();
    act(() => capturedCallbacks.onApprovalResolved?.(makeApproval({ id: "other" })));
    expect(screen.getByTestId("approval-modal")).toBeInTheDocument();
  });

  it("View all link goes to /approvals and closes the dropdown", async () => {
    render(<ApprovalQueue />);
    const user = userEvent.setup();
    await user.click(screen.getByTestId("approval-queue-toggle"));
    const link = screen.getByRole("link", { name: /view all/i });
    expect(link.getAttribute("href")).toBe("/approvals");
    await user.click(link);
    expect(screen.queryByTestId("approval-queue-dropdown")).not.toBeInTheDocument();
  });

  it("keeps the modal open + logs when the decision POST fails", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchSpy = vi.fn(() =>
      Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) } as Response),
    );
    vi.stubGlobal("fetch", fetchSpy);

    render(<ApprovalQueue />);
    act(() => {
      capturedCallbacks.onNewApproval?.(makeApproval({ id: "fail", tool_args: {} }));
    });
    const user = userEvent.setup();
    await user.click(screen.getByTestId("approve-button"));
    expect(fetchSpy).toHaveBeenCalled();
    // Modal stays open after a failed POST.
    expect(screen.getByTestId("approval-modal")).toBeInTheDocument();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
