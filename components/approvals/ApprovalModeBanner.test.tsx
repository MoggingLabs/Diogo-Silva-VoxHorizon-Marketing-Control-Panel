import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
  usePathname: () => "/approvals",
}));

import { ApprovalModeBanner } from "./ApprovalModeBanner";

function setState(s: ApprovalModeState | null, loading = false) {
  hookState.state = s;
  hookState.loading = loading;
}

describe("ApprovalModeBanner", () => {
  beforeEach(() => {
    setState(null);
    if (typeof window !== "undefined") {
      window.sessionStorage.clear();
    }
  });

  afterEach(() => {
    setState(null);
    if (typeof window !== "undefined") {
      window.sessionStorage.clear();
    }
  });

  it("renders nothing while loading", () => {
    setState(null, true);
    const { container } = render(<ApprovalModeBanner />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when mode is ASK", () => {
    setState({
      mode: "ASK",
      expires_at: null,
      set_by: null,
      set_at: "x",
      note: null,
    });
    const { container } = render(<ApprovalModeBanner />);
    expect(container.firstChild).toBeNull();
  });

  it("renders the AUTO_APPROVE banner with TTL", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-19T00:00:00Z"));
    setState({
      mode: "AUTO_APPROVE",
      expires_at: "2026-05-19T04:00:00Z",
      set_by: "dashboard",
      set_at: "x",
      note: null,
    });
    render(<ApprovalModeBanner />);
    const banner = screen.getByTestId("approval-mode-banner");
    expect(banner).toHaveAttribute("data-mode", "AUTO_APPROVE");
    expect(banner.textContent).toContain("Auto-approve mode active");
    vi.useRealTimers();
  });

  it("renders the HALT banner", () => {
    setState({
      mode: "HALT",
      expires_at: null,
      set_by: "dashboard",
      set_at: "x",
      note: null,
    });
    render(<ApprovalModeBanner />);
    const banner = screen.getByTestId("approval-mode-banner");
    expect(banner).toHaveAttribute("data-mode", "HALT");
    expect(banner.textContent).toContain("Approvals are halted");
  });

  it("dismisses when X is clicked", async () => {
    const user = userEvent.setup();
    setState({
      mode: "HALT",
      expires_at: null,
      set_by: "dashboard",
      set_at: "x",
      note: null,
    });
    render(<ApprovalModeBanner />);
    await user.click(screen.getByRole("button", { name: /dismiss/i }));
    expect(screen.queryByTestId("approval-mode-banner")).toBeNull();
    expect(window.sessionStorage.getItem("approval-mode-banner-dismissed")).toBe("1");
  });

  it("renders nothing when previously dismissed (sessionStorage)", () => {
    window.sessionStorage.setItem("approval-mode-banner-dismissed", "1");
    setState({
      mode: "HALT",
      expires_at: null,
      set_by: "dashboard",
      set_at: "x",
      note: null,
    });
    const { container } = render(<ApprovalModeBanner />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing for unknown mode (defensive)", () => {
    setState({
      mode: "INVENT",
      expires_at: null,
      set_by: null,
      set_at: "x",
      note: null,
    });
    const { container } = render(<ApprovalModeBanner />);
    expect(container.firstChild).toBeNull();
  });
});
