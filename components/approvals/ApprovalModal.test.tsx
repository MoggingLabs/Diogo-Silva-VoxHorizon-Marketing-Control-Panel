import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Approval } from "@/lib/approvals/types";

import { ApprovalModal } from "./ApprovalModal";

function makeApproval(overrides: Partial<Approval> = {}): Approval {
  return {
    id: "a1",
    ekko_session_id: "session-1",
    ekko_tool_call_id: "tc-1",
    tool_name: "shell_exec",
    tool_args: { cmd: "ls /tmp", cost: 120 },
    risk_class: "filesystem",
    context: { skill_name: "fs-skill", estimated_cost: 0.25 },
    requested_at: "2026-05-18T10:00:00Z",
    expires_at: "2026-05-18T10:05:00Z",
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

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ApprovalModal", () => {
  it("renders nothing visible when open=false", () => {
    render(
      <ApprovalModal
        approval={makeApproval()}
        open={false}
        onOpenChange={vi.fn()}
        onDecide={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("approval-modal")).not.toBeInTheDocument();
  });

  it("renders the tool name + session in the metadata section", () => {
    render(
      <ApprovalModal
        approval={makeApproval()}
        open={true}
        onOpenChange={vi.fn()}
        onDecide={vi.fn()}
      />,
    );
    expect(screen.getByText("shell_exec")).toBeInTheDocument();
    expect(screen.getByText("session-1")).toBeInTheDocument();
  });

  it("renders the skill name + estimated cost when context is present", () => {
    render(
      <ApprovalModal
        approval={makeApproval()}
        open={true}
        onOpenChange={vi.fn()}
        onDecide={vi.fn()}
      />,
    );
    expect(screen.getByText("fs-skill")).toBeInTheDocument();
    expect(screen.getByText("$0.25")).toBeInTheDocument();
  });

  it("renders the args diff component with the tool args", () => {
    render(
      <ApprovalModal
        approval={makeApproval()}
        open={true}
        onOpenChange={vi.fn()}
        onDecide={vi.fn()}
      />,
    );
    // ApprovalArgsDiff testid surfaces:
    expect(screen.getByTestId("args-diff")).toBeInTheDocument();
  });

  it("fires onDecide('approved', {cache_for_session: false}) when Approve clicked", async () => {
    const onDecide = vi.fn();
    render(
      <ApprovalModal
        approval={makeApproval()}
        open={true}
        onOpenChange={vi.fn()}
        onDecide={onDecide}
      />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByTestId("approve-button"));
    expect(onDecide).toHaveBeenCalledWith("approved", {
      notes: undefined,
      cache_for_session: false,
    });
  });

  it("fires onDecide('rejected', ...) when Reject clicked", async () => {
    const onDecide = vi.fn();
    render(
      <ApprovalModal
        approval={makeApproval()}
        open={true}
        onOpenChange={vi.fn()}
        onDecide={onDecide}
      />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByTestId("reject-button"));
    expect(onDecide).toHaveBeenCalledWith("rejected", {
      notes: undefined,
      cache_for_session: false,
    });
  });

  it("fires onDecide('approved', {cache_for_session:true}) when Approve+Remember clicked", async () => {
    const onDecide = vi.fn();
    render(
      <ApprovalModal
        approval={makeApproval()}
        open={true}
        onOpenChange={vi.fn()}
        onDecide={onDecide}
      />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByTestId("approve-remember-button"));
    expect(onDecide).toHaveBeenCalledWith("approved", {
      notes: undefined,
      cache_for_session: true,
    });
  });

  it("forwards typed notes to the decision callback", async () => {
    const onDecide = vi.fn();
    render(
      <ApprovalModal
        approval={makeApproval()}
        open={true}
        onOpenChange={vi.fn()}
        onDecide={onDecide}
      />,
    );
    const user = userEvent.setup();
    await user.type(screen.getByTestId("approval-notes"), "looks fine");
    await user.click(screen.getByTestId("approve-button"));
    expect(onDecide).toHaveBeenCalledWith("approved", {
      notes: "looks fine",
      cache_for_session: false,
    });
  });

  it("approves on keyboard `A`", () => {
    const onDecide = vi.fn();
    render(
      <ApprovalModal
        approval={makeApproval()}
        open={true}
        onOpenChange={vi.fn()}
        onDecide={onDecide}
      />,
    );
    fireEvent.keyDown(window, { key: "a" });
    expect(onDecide).toHaveBeenCalledWith("approved", {
      notes: undefined,
      cache_for_session: false,
    });
  });

  it("rejects on keyboard `R`", () => {
    const onDecide = vi.fn();
    render(
      <ApprovalModal
        approval={makeApproval()}
        open={true}
        onOpenChange={vi.fn()}
        onDecide={onDecide}
      />,
    );
    fireEvent.keyDown(window, { key: "r" });
    expect(onDecide).toHaveBeenCalledWith("rejected", {
      notes: undefined,
      cache_for_session: false,
    });
  });

  it("approves+remembers on keyboard `S`", () => {
    const onDecide = vi.fn();
    render(
      <ApprovalModal
        approval={makeApproval()}
        open={true}
        onOpenChange={vi.fn()}
        onDecide={onDecide}
      />,
    );
    fireEvent.keyDown(window, { key: "s" });
    expect(onDecide).toHaveBeenCalledWith("approved", {
      notes: undefined,
      cache_for_session: true,
    });
  });

  it("ignores keyboard shortcuts when the notes textarea has focus", () => {
    const onDecide = vi.fn();
    render(
      <ApprovalModal
        approval={makeApproval()}
        open={true}
        onOpenChange={vi.fn()}
        onDecide={onDecide}
      />,
    );
    const textarea = screen.getByTestId("approval-notes");
    textarea.focus();
    fireEvent.keyDown(window, { key: "a" });
    expect(onDecide).not.toHaveBeenCalled();
  });

  it("ignores keyboard shortcuts when not open", () => {
    const onDecide = vi.fn();
    render(
      <ApprovalModal
        approval={makeApproval()}
        open={false}
        onOpenChange={vi.fn()}
        onDecide={onDecide}
      />,
    );
    fireEvent.keyDown(window, { key: "a" });
    expect(onDecide).not.toHaveBeenCalled();
  });

  it("ignores keyboard shortcuts when modifier keys are held", () => {
    const onDecide = vi.fn();
    render(
      <ApprovalModal
        approval={makeApproval()}
        open={true}
        onOpenChange={vi.fn()}
        onDecide={onDecide}
      />,
    );
    fireEvent.keyDown(window, { key: "a", ctrlKey: true });
    expect(onDecide).not.toHaveBeenCalled();
  });

  it("ignores keyboard shortcuts when no approval is selected", () => {
    const onDecide = vi.fn();
    render(
      <ApprovalModal approval={null} open={true} onOpenChange={vi.fn()} onDecide={onDecide} />,
    );
    fireEvent.keyDown(window, { key: "a" });
    expect(onDecide).not.toHaveBeenCalled();
  });

  it("ignores keyboard shortcuts for unrecognised keys", () => {
    const onDecide = vi.fn();
    render(
      <ApprovalModal
        approval={makeApproval()}
        open={true}
        onOpenChange={vi.fn()}
        onDecide={onDecide}
      />,
    );
    fireEvent.keyDown(window, { key: "x" });
    expect(onDecide).not.toHaveBeenCalled();
  });

  it("resets the notes state when the approval id changes", async () => {
    const onDecide = vi.fn();
    const { rerender } = render(
      <ApprovalModal
        approval={makeApproval({ id: "a1" })}
        open={true}
        onOpenChange={vi.fn()}
        onDecide={onDecide}
      />,
    );
    const user = userEvent.setup();
    await user.type(screen.getByTestId("approval-notes"), "old notes");
    expect(screen.getByTestId("approval-notes")).toHaveValue("old notes");

    rerender(
      <ApprovalModal
        approval={makeApproval({ id: "a2" })}
        open={true}
        onOpenChange={vi.fn()}
        onDecide={onDecide}
      />,
    );
    expect(screen.getByTestId("approval-notes")).toHaveValue("");
  });

  it("disables decision buttons while a submission is in flight", async () => {
    let resolve!: () => void;
    const onDecide = vi.fn(
      () =>
        new Promise<void>((r) => {
          resolve = r;
        }),
    );
    render(
      <ApprovalModal
        approval={makeApproval()}
        open={true}
        onOpenChange={vi.fn()}
        onDecide={onDecide}
      />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByTestId("approve-button"));
    expect(screen.getByTestId("approve-button")).toBeDisabled();
    expect(screen.getByTestId("reject-button")).toBeDisabled();
    expect(screen.getByTestId("approve-remember-button")).toBeDisabled();
    resolve();
    await waitFor(() => expect(screen.getByTestId("approve-button")).not.toBeDisabled());
  });

  it("renders the past-decisions audit trail when supplied", () => {
    const past = [
      {
        ...makeApproval({ id: "p1", decision: "approved", status: "decided" }),
      },
    ];
    render(
      <ApprovalModal
        approval={makeApproval()}
        open={true}
        onOpenChange={vi.fn()}
        onDecide={vi.fn()}
        pastDecisions={past}
      />,
    );
    expect(screen.getByText(/Past decisions/i)).toBeInTheDocument();
    expect(screen.getByTestId("audit-trail")).toBeInTheDocument();
  });

  it("renders the empty-state inner block when approval=null but open=true", () => {
    render(<ApprovalModal approval={null} open={true} onOpenChange={vi.fn()} onDecide={vi.fn()} />);
    expect(screen.getByTestId("modal-empty")).toBeInTheDocument();
  });

  it("ignores a second Approve while the first is still in flight", async () => {
    let resolve!: () => void;
    const onDecide = vi.fn(
      () =>
        new Promise<void>((r) => {
          resolve = r;
        }),
    );
    render(
      <ApprovalModal
        approval={makeApproval()}
        open={true}
        onOpenChange={vi.fn()}
        onDecide={onDecide}
      />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByTestId("approve-button"));
    // Even pressing the keyboard shortcut during a pending submission is a no-op.
    fireEvent.keyDown(window, { key: "a" });
    expect(onDecide).toHaveBeenCalledTimes(1);
    resolve();
    await waitFor(() => expect(screen.getByTestId("approve-button")).not.toBeDisabled());
  });
});
