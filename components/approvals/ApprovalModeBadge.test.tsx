import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ApprovalModeState } from "@/lib/approval-mode/types";

type HookState = {
  state: ApprovalModeState | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
};

const hookState: HookState = {
  state: null,
  loading: false,
  error: null,
  refresh: vi.fn(async () => undefined),
};

vi.mock("@/hooks/approvals/useApprovalMode", () => ({
  useApprovalMode: () => hookState,
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/",
}));

import { ApprovalModeBadge } from "./ApprovalModeBadge";

function setState(s: ApprovalModeState | null, loading = false) {
  hookState.state = s;
  hookState.loading = loading;
}

describe("ApprovalModeBadge", () => {
  beforeEach(() => {
    setState(null);
  });

  afterEach(() => {
    setState(null);
  });

  it("renders nothing while loading", () => {
    setState(null, true);
    const { container } = render(<ApprovalModeBadge />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when mode is ASK", () => {
    setState({
      mode: "ASK",
      expires_at: null,
      set_by: "dashboard",
      set_at: "2026-05-19T00:00:00Z",
      note: null,
    });
    const { container } = render(<ApprovalModeBadge />);
    expect(container.firstChild).toBeNull();
  });

  it("renders Halted pill when mode is HALT", () => {
    setState({
      mode: "HALT",
      expires_at: null,
      set_by: "dashboard",
      set_at: "2026-05-19T00:00:00Z",
      note: null,
    });
    render(<ApprovalModeBadge />);
    const badge = screen.getByTestId("approval-mode-badge");
    expect(badge).toHaveAttribute("data-mode", "HALT");
    expect(badge.textContent).toContain("Halted");
  });

  it("renders Auto pill with remaining TTL when AUTO_APPROVE", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-19T00:00:00Z"));
    setState({
      mode: "AUTO_APPROVE",
      expires_at: "2026-05-19T03:12:00Z",
      set_by: "dashboard",
      set_at: "2026-05-19T00:00:00Z",
      note: "batch",
    });
    render(<ApprovalModeBadge />);
    const badge = screen.getByTestId("approval-mode-badge");
    expect(badge).toHaveAttribute("data-mode", "AUTO_APPROVE");
    expect(badge.textContent).toContain("Auto");
    expect(badge.textContent).toContain("03h12m");
    vi.useRealTimers();
  });

  it("renders nothing for an unknown mode (defensive)", () => {
    setState({
      mode: "SOMETHING_ELSE",
      expires_at: null,
      set_by: null,
      set_at: "x",
      note: null,
    });
    const { container } = render(<ApprovalModeBadge />);
    expect(container.firstChild).toBeNull();
  });

  it("links to /settings", () => {
    setState({
      mode: "HALT",
      expires_at: null,
      set_by: "dashboard",
      set_at: "x",
      note: null,
    });
    render(<ApprovalModeBadge />);
    const badge = screen.getByTestId("approval-mode-badge");
    expect(badge.getAttribute("href")).toBe("/settings");
  });
});
