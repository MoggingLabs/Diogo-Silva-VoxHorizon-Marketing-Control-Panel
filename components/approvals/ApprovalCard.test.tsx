import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { Approval } from "@/lib/approvals/types";

import { ApprovalCard } from "./ApprovalCard";

function makeApproval(overrides: Partial<Approval> = {}): Approval {
  return {
    id: "a1",
    ekko_session_id: "session-1",
    ekko_tool_call_id: "tc-1",
    tool_name: "shell_exec",
    tool_args: { cmd: "ls /tmp" },
    risk_class: "filesystem",
    context: null,
    requested_at: new Date(Date.now() - 5 * 60_000).toISOString(),
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

describe("ApprovalCard", () => {
  it("renders the tool name", () => {
    render(<ApprovalCard approval={makeApproval()} />);
    expect(screen.getByText("shell_exec")).toBeInTheDocument();
  });

  it("renders the relative time since requested_at", () => {
    render(<ApprovalCard approval={makeApproval()} />);
    expect(screen.getByTestId("time-since").textContent).toMatch(/m ago|just now/);
  });

  it("falls back to ekko_session_id when no skill name is set", () => {
    render(<ApprovalCard approval={makeApproval()} />);
    expect(screen.getByText("session-1")).toBeInTheDocument();
  });

  it("renders the skill name from the context when set", () => {
    render(<ApprovalCard approval={makeApproval({ context: { skill_name: "demo-skill" } })} />);
    expect(screen.getByText("demo-skill")).toBeInTheDocument();
  });

  it("renders the spend risk icon when risk_class='spend'", () => {
    const { container } = render(<ApprovalCard approval={makeApproval({ risk_class: "spend" })} />);
    expect(container.querySelector('[data-testid="risk-icon"]')).toBeInTheDocument();
  });

  it("calls onSelect with the approval when clicked", async () => {
    const handler = vi.fn();
    const approval = makeApproval();
    render(<ApprovalCard approval={approval} onSelect={handler} />);
    const user = userEvent.setup();
    await user.click(screen.getByTestId(`approval-card-${approval.id}`));
    expect(handler).toHaveBeenCalledWith(approval);
  });

  it("renders the active style when active=true", () => {
    const { rerender } = render(<ApprovalCard approval={makeApproval()} active={false} />);
    const node = screen.getByTestId("approval-card-a1");
    expect(node.dataset.active).toBeUndefined();
    rerender(<ApprovalCard approval={makeApproval()} active={true} />);
    expect(screen.getByTestId("approval-card-a1").dataset.active).toBe("true");
  });

  it("shows the money badge when tool_args includes a money-class leaf", () => {
    render(<ApprovalCard approval={makeApproval({ tool_args: { cost: 250 } })} />);
    expect(screen.getByText("$1")).toBeInTheDocument(); // count "1" prefixed with $
  });

  it("shows the path badge when tool_args has path leaves", () => {
    render(
      <ApprovalCard approval={makeApproval({ tool_args: { p: "/etc/hosts", q: "/var/log" } })} />,
    );
    expect(screen.getByText(/2 path/i)).toBeInTheDocument();
  });

  it("shows the url badge when tool_args has url leaves", () => {
    render(<ApprovalCard approval={makeApproval({ tool_args: { u: "https://x.dev" } })} />);
    expect(screen.getByText(/1 url/i)).toBeInTheDocument();
  });

  it("falls back to the unknown icon for unrecognised risk_class strings", () => {
    const { container } = render(
      <ApprovalCard approval={makeApproval({ risk_class: "made-up" })} />,
    );
    expect(container.querySelector('[data-testid="risk-icon"]')).toBeInTheDocument();
  });
});
