/**
 * Tests for DaemonHealthBadge (silent-failure PR-2a).
 *
 * Covers each of the four `freshness` states (live / starting / stale / down)
 * + the down-with-startup-reason chip + the disclosure for the full
 * startup_check JSON. The hook is mocked so we drive the component
 * synchronously without juggling fetch + realtime.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DaemonFreshness, WorkItemConsumer } from "@/lib/work-queue/types";

const mockState: { consumer: WorkItemConsumer | null; freshness: DaemonFreshness } = {
  consumer: null,
  freshness: "down",
};

vi.mock("@/hooks/useDaemonHealth", () => ({
  useDaemonHealth: () => ({ ...mockState, isLoading: false, error: null }),
}));

import { DaemonHealthBadge } from "./DaemonHealthBadge";

function consumer(over: Partial<WorkItemConsumer> = {}): WorkItemConsumer {
  return {
    id: "operator-daemon-1",
    kind: "operator_dispatch",
    status: "live",
    startup_check: { auth: "ok", hermes: "ok" },
    last_seen_at: "2026-05-26T12:00:00Z",
    image_tag: "operator:1.2.3",
    hostname: "operator-1",
    created_at: "2026-05-26T11:00:00Z",
    updated_at: "2026-05-26T12:00:00Z",
    ...over,
  };
}

beforeEach(() => {
  mockState.consumer = null;
  mockState.freshness = "down";
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("DaemonHealthBadge", () => {
  it("renders the live state in success palette", () => {
    mockState.consumer = consumer();
    mockState.freshness = "live";
    render(<DaemonHealthBadge />);
    const badge = screen.getByTestId("daemon-health-badge");
    expect(badge).toHaveAttribute("data-freshness", "live");
    expect(screen.getByText(/Operator daemon: live/i)).toBeInTheDocument();
  });

  it("renders the starting state with the spinner palette", () => {
    mockState.consumer = consumer({ status: "starting", startup_check: null });
    mockState.freshness = "starting";
    render(<DaemonHealthBadge />);
    expect(screen.getByTestId("daemon-health-badge")).toHaveAttribute("data-freshness", "starting");
    expect(screen.getByText(/Operator daemon: starting/i)).toBeInTheDocument();
  });

  it("renders the stale state in warning palette", () => {
    mockState.consumer = consumer({
      status: "degraded",
      last_seen_at: new Date("2026-05-26T11:55:00Z").toISOString(),
    });
    mockState.freshness = "stale";
    render(<DaemonHealthBadge />);
    expect(screen.getByTestId("daemon-health-badge")).toHaveAttribute("data-freshness", "stale");
    expect(screen.getByText(/heartbeat stale/i)).toBeInTheDocument();
  });

  it("renders the down state in destructive palette + auth_expired chip", () => {
    mockState.consumer = consumer({
      status: "down",
      startup_check: { auth: "expired", hermes: "ok" },
    });
    mockState.freshness = "down";
    render(<DaemonHealthBadge />);
    expect(screen.getByTestId("daemon-health-badge")).toHaveAttribute("data-freshness", "down");
    expect(screen.getByText(/Operator daemon: DOWN/i)).toBeInTheDocument();
    expect(screen.getByTestId("daemon-startup-check-auth")).toHaveTextContent(/auth: expired/i);
  });

  it("renders down state with multiple failed startup checks", () => {
    mockState.consumer = consumer({
      status: "down",
      startup_check: { auth: "expired", hermes: "init_failed", llm: "ok" },
    });
    mockState.freshness = "down";
    render(<DaemonHealthBadge />);
    // auth + hermes should render (both not "ok"); llm should not.
    expect(screen.getByTestId("daemon-startup-check-auth")).toBeInTheDocument();
    expect(screen.getByTestId("daemon-startup-check-hermes")).toBeInTheDocument();
    expect(screen.queryByTestId("daemon-startup-check-llm")).not.toBeInTheDocument();
  });

  it("renders down with NO startup_check (consumer never wrote one)", () => {
    mockState.consumer = consumer({ status: "down", startup_check: null });
    mockState.freshness = "down";
    render(<DaemonHealthBadge />);
    expect(screen.getByText(/Operator daemon: DOWN/i)).toBeInTheDocument();
    // The chip + disclosure are only rendered when startup_check has content.
    expect(screen.queryByTestId("daemon-startup-check-auth")).not.toBeInTheDocument();
  });

  it("opens the full startup_check JSON disclosure on click", async () => {
    mockState.consumer = consumer({ status: "live", startup_check: { auth: "ok", hermes: "ok" } });
    mockState.freshness = "live";
    const user = userEvent.setup();
    render(<DaemonHealthBadge />);
    expect(screen.queryByTestId("daemon-startup-check-json")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /details/i }));
    expect(screen.getByTestId("daemon-startup-check-json")).toBeInTheDocument();
    expect(screen.getByTestId("daemon-startup-check-json").textContent).toContain('"auth": "ok"');
  });

  it("renders down with no consumer row (daemon has never booted)", () => {
    mockState.consumer = null;
    mockState.freshness = "down";
    render(<DaemonHealthBadge />);
    expect(screen.getByText(/Operator daemon: DOWN/i)).toBeInTheDocument();
  });
});
