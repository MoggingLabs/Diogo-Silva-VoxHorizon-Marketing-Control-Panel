import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

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

function okFetch() {
  return vi.fn(() =>
    Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) } as Response),
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ApprovalCard", () => {
  it("renders the 'Client — Purpose' title for a render approval", () => {
    render(
      <ApprovalCard
        approval={makeApproval({
          tool_name: "mcp_pipeline_operator_pipeline_operator_render",
          tool_args: { pipeline_id: "p1", kind: "concept_preview", items: [1, 2, 3] },
          client_name: "Acme Co",
        })}
      />,
    );
    expect(screen.getByTestId("card-title").textContent).toBe(
      "Acme Co — Render 3 concept previews",
    );
  });

  it("falls back to the session id in the title when no client/skill is set", () => {
    render(<ApprovalCard approval={makeApproval()} />);
    expect(screen.getByTestId("card-title").textContent).toBe("session-1 — Shell exec");
  });

  it("renders the relative time since requested_at", () => {
    render(<ApprovalCard approval={makeApproval()} />);
    expect(screen.getByTestId("time-since").textContent).toMatch(/m ago|just now/);
  });

  it("renders the spend risk icon when risk_class='spend'", () => {
    const { container } = render(<ApprovalCard approval={makeApproval({ risk_class: "spend" })} />);
    expect(container.querySelector('[data-testid="risk-icon"]')).toBeInTheDocument();
  });

  it("calls onSelect with the approval when the body is clicked", async () => {
    const handler = vi.fn();
    const approval = makeApproval();
    render(<ApprovalCard approval={approval} onSelect={handler} />);
    const user = userEvent.setup();
    await user.click(screen.getByTestId(`approval-card-body-${approval.id}`));
    expect(handler).toHaveBeenCalledWith(approval);
  });

  it("renders the active style when active=true", () => {
    const { rerender } = render(<ApprovalCard approval={makeApproval()} active={false} />);
    const node = screen.getByTestId("approval-card-a1");
    expect(node.dataset.active).toBeUndefined();
    rerender(<ApprovalCard approval={makeApproval()} active={true} />);
    expect(screen.getByTestId("approval-card-a1").dataset.active).toBe("true");
  });

  it("shows the inline Approve / Reject buttons when pending", () => {
    render(<ApprovalCard approval={makeApproval()} />);
    expect(screen.getByTestId("approval-card-approve-a1")).toBeInTheDocument();
    expect(screen.getByTestId("approval-card-reject-a1")).toBeInTheDocument();
  });

  it("does NOT show inline actions when the approval is not pending", () => {
    render(<ApprovalCard approval={makeApproval({ status: "decided" })} />);
    expect(screen.queryByTestId("approval-card-approve-a1")).not.toBeInTheDocument();
  });

  it("POSTs the decision with the modal body shape on inline Approve", async () => {
    const fetchSpy = okFetch();
    vi.stubGlobal("fetch", fetchSpy);
    const onDecided = vi.fn();
    render(<ApprovalCard approval={makeApproval({ id: "x" })} onDecided={onDecided} />);

    const user = userEvent.setup();
    await user.click(screen.getByTestId("approval-card-approve-x"));

    expect(fetchSpy).toHaveBeenCalled();
    const call = fetchSpy.mock.calls[0] as unknown[];
    expect(call[0]).toBe("/api/approvals/x/decision");
    const init = call[1] as RequestInit;
    const body = JSON.parse(init.body as string);
    expect(body.decision).toBe("approved");
    expect(body.cache_for_session).toBe(false);
    await waitFor(() => expect(onDecided).toHaveBeenCalled());
  });

  it("POSTs decision=rejected on inline Reject with a default note", async () => {
    const fetchSpy = okFetch();
    vi.stubGlobal("fetch", fetchSpy);
    render(<ApprovalCard approval={makeApproval({ id: "y" })} />);

    const user = userEvent.setup();
    await user.click(screen.getByTestId("approval-card-reject-y"));

    const call = fetchSpy.mock.calls[0] as unknown[];
    const body = JSON.parse((call[1] as RequestInit).body as string);
    expect(body.decision).toBe("rejected");
    expect(typeof body.notes).toBe("string");
  });

  it("surfaces an error via role=alert when the POST fails", async () => {
    const fetchSpy = vi.fn(() =>
      Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) } as Response),
    );
    vi.stubGlobal("fetch", fetchSpy);
    render(<ApprovalCard approval={makeApproval({ id: "z" })} />);

    const user = userEvent.setup();
    await user.click(screen.getByTestId("approval-card-approve-z"));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/HTTP 500|failed/i);
    // Buttons re-enabled after the failure so the operator can retry.
    expect(screen.getByTestId("approval-card-approve-z")).not.toBeDisabled();
  });

  it("disables both inline buttons while a decision is in flight", async () => {
    let resolveFetch: ((r: Response) => void) | undefined;
    const fetchSpy = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    render(<ApprovalCard approval={makeApproval({ id: "w" })} />);

    const user = userEvent.setup();
    await user.click(screen.getByTestId("approval-card-approve-w"));

    expect(screen.getByTestId("approval-card-approve-w")).toBeDisabled();
    expect(screen.getByTestId("approval-card-reject-w")).toBeDisabled();

    resolveFetch?.({ ok: true, status: 200, json: () => Promise.resolve({}) } as Response);
  });
});
