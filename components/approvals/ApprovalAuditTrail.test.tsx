import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { Approval, ApprovalDecision, ApprovalStatus } from "@/lib/approvals/types";

import { ApprovalAuditTrail } from "./ApprovalAuditTrail";

function makeApproval(overrides: Partial<Approval> = {}): Approval {
  return {
    id: "a1",
    ekko_session_id: "s1",
    ekko_tool_call_id: "tc1",
    tool_name: "read_file",
    tool_args: {},
    risk_class: "filesystem",
    context: null,
    requested_at: new Date(Date.now() - 60_000).toISOString(),
    expires_at: new Date(Date.now() + 60_000).toISOString(),
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

describe("ApprovalAuditTrail", () => {
  it("renders the empty state when no rows are passed", () => {
    render(<ApprovalAuditTrail approvals={[]} />);
    expect(screen.getByTestId("audit-empty")).toBeInTheDocument();
  });

  it("renders a custom empty message", () => {
    render(<ApprovalAuditTrail approvals={[]} emptyMessage="nada" />);
    expect(screen.getByTestId("audit-empty").textContent).toBe("nada");
  });

  it("renders one row per approval", () => {
    render(
      <ApprovalAuditTrail
        approvals={[makeApproval({ id: "a1" }), makeApproval({ id: "a2", decision: "rejected" })]}
      />,
    );
    expect(screen.getByTestId("audit-row-a1")).toBeInTheDocument();
    expect(screen.getByTestId("audit-row-a2")).toBeInTheDocument();
  });

  it("renders the decision label for approved/rejected/approved_with_caveat", () => {
    render(
      <ApprovalAuditTrail
        approvals={[
          makeApproval({ id: "a-approved", decision: "approved" }),
          makeApproval({ id: "a-rejected", decision: "rejected" }),
          makeApproval({ id: "a-caveat", decision: "approved_with_caveat" }),
        ]}
      />,
    );
    expect(screen.getByTestId("audit-row-a-approved").textContent).toMatch(/Approved/);
    expect(screen.getByTestId("audit-row-a-rejected").textContent).toMatch(/Rejected/);
    expect(screen.getByTestId("audit-row-a-caveat").textContent).toMatch(/Approved \(caveat\)/);
  });

  it("renders Cancelled when status='cancelled'", () => {
    render(
      <ApprovalAuditTrail
        approvals={[makeApproval({ id: "c", status: "cancelled", decision: null })]}
      />,
    );
    expect(screen.getByTestId("audit-row-c").textContent).toMatch(/Cancelled/);
  });

  it("renders Expired when status='expired'", () => {
    render(
      <ApprovalAuditTrail
        approvals={[makeApproval({ id: "e", status: "expired", decision: null })]}
      />,
    );
    expect(screen.getByTestId("audit-row-e").textContent).toMatch(/Expired/);
  });

  it("renders Pending when no decision and status='pending'", () => {
    render(
      <ApprovalAuditTrail
        approvals={[makeApproval({ id: "p", status: "pending", decision: null })]}
      />,
    );
    expect(screen.getByTestId("audit-row-p").textContent).toMatch(/Pending/);
  });

  it("renders the decision notes when present", () => {
    render(
      <ApprovalAuditTrail approvals={[makeApproval({ decision_notes: "looked OK", id: "n" })]} />,
    );
    expect(within(screen.getByTestId("audit-row-n")).getByText("looked OK")).toBeInTheDocument();
  });

  it("renders the cache flag when cache_for_session is true", () => {
    render(<ApprovalAuditTrail approvals={[makeApproval({ cache_for_session: true, id: "c" })]} />);
    expect(screen.getByTestId("cache-flag")).toBeInTheDocument();
  });

  it("does not render the cache flag when cache_for_session is false/null", () => {
    render(
      <ApprovalAuditTrail approvals={[makeApproval({ cache_for_session: null, id: "c1" })]} />,
    );
    expect(screen.queryByTestId("cache-flag")).not.toBeInTheDocument();
  });

  it("preserves the order of the supplied approvals", () => {
    render(
      <ApprovalAuditTrail
        approvals={[
          makeApproval({ id: "older", tool_name: "older_tool" }),
          makeApproval({ id: "newer", tool_name: "newer_tool" }),
        ]}
      />,
    );
    const rows = screen.getAllByText(/_tool/).map((el) => el.textContent);
    expect(rows[0]).toContain("older_tool");
    expect(rows[1]).toContain("newer_tool");
  });
});
