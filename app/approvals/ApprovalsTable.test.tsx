import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Approval, ApprovalDecision, ApprovalStatus } from "@/lib/approvals/types";

const routerRefresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: routerRefresh, push: vi.fn(), replace: vi.fn() }),
}));

import { ApprovalsTable } from "./ApprovalsTable";

function makeApproval(overrides: Partial<Approval> = {}): Approval {
  return {
    id: "a1",
    ekko_session_id: "s",
    ekko_tool_call_id: "tc",
    tool_name: "t",
    tool_args: {},
    risk_class: "filesystem",
    context: null,
    requested_at: new Date().toISOString(),
    expires_at: new Date().toISOString(),
    status: "decided" as ApprovalStatus,
    decision: "approved" as ApprovalDecision,
    decided_by: "dashboard",
    decided_at: new Date().toISOString(),
    decision_notes: null,
    cache_for_session: false,
    cache_for_minutes: null,
    worker_received_at: null,
    ...overrides,
  };
}

afterEach(() => {
  routerRefresh.mockReset();
  vi.restoreAllMocks();
});

describe("ApprovalsTable", () => {
  it("renders the empty state when no approvals", () => {
    render(<ApprovalsTable approvals={[]} />);
    expect(screen.getByTestId("audit-empty")).toHaveTextContent(/no approvals/i);
  });

  it("renders one row per approval", () => {
    render(<ApprovalsTable approvals={[makeApproval({ id: "a1" }), makeApproval({ id: "a2" })]} />);
    expect(screen.getByTestId("approvals-table-row-a1")).toBeInTheDocument();
    expect(screen.getByTestId("approvals-table-row-a2")).toBeInTheDocument();
  });

  it("opens the modal when a row is clicked", async () => {
    render(<ApprovalsTable approvals={[makeApproval({ id: "x" })]} />);
    const user = userEvent.setup();
    await user.click(screen.getByTestId("approvals-table-row-x"));
    expect(screen.getByTestId("approval-modal")).toBeInTheDocument();
  });

  it("POSTs the decision when the modal Approve is clicked + refreshes the router", async () => {
    const fetchSpy: ReturnType<typeof vi.fn> = vi.fn(() =>
      Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) } as Response),
    );
    vi.stubGlobal("fetch", fetchSpy);

    render(<ApprovalsTable approvals={[makeApproval({ id: "p" })]} />);
    const user = userEvent.setup();
    await user.click(screen.getByTestId("approvals-table-row-p"));
    await user.click(screen.getByTestId("approve-button"));
    expect(fetchSpy).toHaveBeenCalled();
    const firstCall = fetchSpy.mock.calls[0] as unknown[] | undefined;
    expect(firstCall?.[0]).toBe("/api/approvals/p/decision");
    expect(routerRefresh).toHaveBeenCalled();
  });

  it("does NOT refresh the router when the decision POST fails", async () => {
    const fetchSpy = vi.fn(() =>
      Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) } as Response),
    );
    vi.stubGlobal("fetch", fetchSpy);

    render(<ApprovalsTable approvals={[makeApproval({ id: "fail" })]} />);
    const user = userEvent.setup();
    await user.click(screen.getByTestId("approvals-table-row-fail"));
    await user.click(screen.getByTestId("approve-button"));
    expect(fetchSpy).toHaveBeenCalled();
    expect(routerRefresh).not.toHaveBeenCalled();
  });

  it("logs + leaves the modal open when fetch throws", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchSpy = vi.fn(() => Promise.reject(new Error("kaboom")));
    vi.stubGlobal("fetch", fetchSpy);

    render(<ApprovalsTable approvals={[makeApproval({ id: "fail" })]} />);
    const user = userEvent.setup();
    await user.click(screen.getByTestId("approvals-table-row-fail"));
    await user.click(screen.getByTestId("approve-button"));
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
