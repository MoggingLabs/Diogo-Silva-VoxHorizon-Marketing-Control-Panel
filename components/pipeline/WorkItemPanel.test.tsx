/**
 * Tests for WorkItemPanel (silent-failure PR-2a).
 *
 * Covers:
 *  - All 7 work_item_status values render the right status pill.
 *  - The "no row" idle state.
 *  - The retry-chain collapsible.
 *  - Failure detail (error_kind + truncated msg) on failed/timed_out.
 *  - The Redispatch button is DISABLED + has the PR-2b tooltip text.
 *  - The Cancel button (reused CancelPipelineButton) is present.
 *  - Heartbeat-staleness derivation.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  PipelineDispatchState,
  WorkItem,
  WorkItemConsumer,
  WorkItemStatus,
} from "@/lib/work-queue/types";

const routerRefresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: routerRefresh, push: vi.fn(), replace: vi.fn() }),
}));

// We mock useActiveWorkItem so the panel can render any state without fetch.
const activeWorkItemState: {
  activeWorkItem: WorkItem | null;
  isLoading: boolean;
  error: string | null;
} = {
  activeWorkItem: null,
  isLoading: false,
  error: null,
};
vi.mock("@/hooks/useActiveWorkItem", () => ({
  useActiveWorkItem: () => ({
    ...activeWorkItemState,
    recentEvents: [],
    derivedStatus: null,
  }),
}));

// useDaemonHealth is also mocked (DaemonHealthBadge is embedded). We render a
// 'live' badge by default so tests focus on the work_item panel.
const daemonState: { consumer: WorkItemConsumer | null; freshness: string } = {
  consumer: null,
  freshness: "down",
};
vi.mock("@/hooks/useDaemonHealth", () => ({
  useDaemonHealth: () => ({ ...daemonState, isLoading: false, error: null }),
}));

// CancelPipelineButton makes a fetch on confirm; we don't need to drive it
// here, we just need it to render so the test asserts the wiring.
vi.mock("@/lib/pipeline/client", () => ({
  cancelPipeline: vi.fn(() => Promise.resolve({ pipeline: { id: "p1", status: "cancelled" } })),
}));

import { WorkItemPanel } from "./WorkItemPanel";

function workItem(over: Partial<WorkItem> = {}): WorkItem {
  return {
    id: "wi-1",
    kind: "operator_dispatch",
    pipeline_id: "p1",
    creative_id: null,
    brief_id: null,
    status: "running",
    attempt: 1,
    claim_token: "tok",
    claimed_by: "operator-daemon-1",
    claimed_at: "2026-05-26T12:00:00Z",
    heartbeat_at: new Date().toISOString(),
    completed_at: null,
    error_kind: null,
    error_detail: null,
    payload: { stage: "configuration" },
    result: null,
    idempotency_key: "op-disp:p1:configuration:kickoff",
    parent_work_item_id: null,
    created_by: "api/pipelines/operator",
    next_attempt_at: "2026-05-26T12:00:00Z",
    created_at: "2026-05-26T11:55:00Z",
    updated_at: "2026-05-26T12:00:00Z",
    ...over,
  };
}

function makeState(wi: WorkItem | null): PipelineDispatchState {
  return {
    pipelineId: "p1",
    derivedStatus: "configuration",
    activeWorkItem: wi,
    recentEvents: [],
    operatorDaemon: null,
  };
}

beforeEach(() => {
  routerRefresh.mockReset();
  activeWorkItemState.activeWorkItem = null;
  activeWorkItemState.isLoading = false;
  activeWorkItemState.error = null;
  daemonState.consumer = null;
  daemonState.freshness = "down";
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("WorkItemPanel — per-status rendering", () => {
  const STATUSES: WorkItemStatus[] = [
    "queued",
    "claimed",
    "running",
    "completed",
    "failed",
    "timed_out",
    "cancelled",
  ];

  for (const status of STATUSES) {
    it(`renders the '${status}' state pill`, () => {
      activeWorkItemState.activeWorkItem = workItem({
        status,
        error_kind: status === "failed" || status === "timed_out" ? "auth_expired" : null,
        completed_at:
          status === "completed" || status === "failed" || status === "timed_out"
            ? "2026-05-26T12:01:00Z"
            : null,
        claim_token:
          status === "queued" ||
          status === "completed" ||
          status === "failed" ||
          status === "timed_out" ||
          status === "cancelled"
            ? null
            : "tok",
        claimed_by:
          status === "queued" ||
          status === "completed" ||
          status === "failed" ||
          status === "timed_out" ||
          status === "cancelled"
            ? null
            : "operator-daemon-1",
        claimed_at:
          status === "queued" ||
          status === "completed" ||
          status === "failed" ||
          status === "timed_out" ||
          status === "cancelled"
            ? null
            : "2026-05-26T12:00:00Z",
      });
      render(
        <WorkItemPanel
          pipelineId="p1"
          initialState={makeState(activeWorkItemState.activeWorkItem)}
        />,
      );
      const panel = screen.getByTestId("work-item-panel");
      expect(panel).toHaveAttribute("data-state", status);
    });
  }
});

describe("WorkItemPanel — idle / loading / error", () => {
  it("renders the idle state when no activeWorkItem exists", () => {
    activeWorkItemState.activeWorkItem = null;
    render(<WorkItemPanel pipelineId="p1" initialState={makeState(null)} />);
    expect(screen.getByTestId("work-item-panel")).toHaveAttribute("data-state", "idle");
    expect(screen.getByText(/Dispatcher idle/i)).toBeInTheDocument();
  });

  it("renders the loading state when fetching and no row yet", () => {
    activeWorkItemState.isLoading = true;
    activeWorkItemState.activeWorkItem = null;
    render(<WorkItemPanel pipelineId="p1" />);
    expect(screen.getByTestId("work-item-panel")).toHaveAttribute("data-state", "loading");
    expect(screen.getByText(/Loading dispatch state/i)).toBeInTheDocument();
  });

  it("renders the error state when the hook surfaces an error", () => {
    activeWorkItemState.error = "boom";
    render(<WorkItemPanel pipelineId="p1" />);
    expect(screen.getByTestId("work-item-panel")).toHaveAttribute("data-state", "error");
    expect(screen.getByRole("alert")).toHaveTextContent(/boom/);
  });
});

describe("WorkItemPanel — freshness + failure + retry chain", () => {
  it("flags a stale heartbeat on a running work_item", () => {
    const wi = workItem({
      status: "running",
      heartbeat_at: new Date(Date.now() - 5 * 60_000).toISOString(),
    });
    activeWorkItemState.activeWorkItem = wi;
    render(<WorkItemPanel pipelineId="p1" initialState={makeState(wi)} />);
    expect(screen.getByTestId("work-item-freshness")).toHaveAttribute("data-stale", "yes");
  });

  it("renders no-heartbeat fallback when heartbeat_at is null", () => {
    const wi = workItem({ status: "claimed", heartbeat_at: null });
    activeWorkItemState.activeWorkItem = wi;
    render(<WorkItemPanel pipelineId="p1" initialState={makeState(wi)} />);
    expect(screen.getByText(/no heartbeat yet/i)).toBeInTheDocument();
  });

  it("does NOT render the freshness row for terminal states", () => {
    const wi = workItem({
      status: "completed",
      completed_at: "2026-05-26T12:01:00Z",
      claim_token: null,
      claimed_by: null,
      claimed_at: null,
    });
    activeWorkItemState.activeWorkItem = wi;
    render(<WorkItemPanel pipelineId="p1" initialState={makeState(wi)} />);
    expect(screen.queryByTestId("work-item-freshness")).not.toBeInTheDocument();
  });

  it("surfaces error_kind + truncated msg on failed", () => {
    const long = "x".repeat(300);
    const wi = workItem({
      status: "failed",
      error_kind: "auth_expired",
      error_detail: { msg: long },
      completed_at: "2026-05-26T12:01:00Z",
      claim_token: null,
      claimed_by: null,
      claimed_at: null,
    });
    activeWorkItemState.activeWorkItem = wi;
    render(<WorkItemPanel pipelineId="p1" initialState={makeState(wi)} />);
    const failure = screen.getByTestId("work-item-failure");
    expect(failure).toHaveTextContent(/auth_expired/);
    // 240-char truncation + ellipsis.
    expect(failure.textContent?.includes("…")).toBe(true);
  });

  it("renders the retry chain collapsible when parent_work_item_id is set", async () => {
    const wi = workItem({ parent_work_item_id: "wi-0", attempt: 2 });
    activeWorkItemState.activeWorkItem = wi;
    const user = userEvent.setup();
    render(<WorkItemPanel pipelineId="p1" initialState={makeState(wi)} />);
    expect(screen.getByTestId("work-item-retry-chain")).toBeInTheDocument();
    // Closed by default.
    expect(screen.queryByText(/retried from parent/i)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /retry chain/i }));
    expect(screen.getByText(/wi-0/)).toBeInTheDocument();
  });

  it("does NOT render the retry chain when there is no parent", () => {
    activeWorkItemState.activeWorkItem = workItem({ parent_work_item_id: null });
    render(
      <WorkItemPanel
        pipelineId="p1"
        initialState={makeState(activeWorkItemState.activeWorkItem)}
      />,
    );
    expect(screen.queryByTestId("work-item-retry-chain")).not.toBeInTheDocument();
  });
});

describe("WorkItemPanel — recovery actions", () => {
  it("renders a DISABLED Redispatch button with a PR-2b tooltip", () => {
    const wi = workItem({
      status: "failed",
      completed_at: "2026-05-26T12:01:00Z",
      claim_token: null,
      claimed_by: null,
      claimed_at: null,
      error_kind: "auth_expired",
    });
    activeWorkItemState.activeWorkItem = wi;
    render(<WorkItemPanel pipelineId="p1" initialState={makeState(wi)} />);
    const btn = screen.getByTestId("work-item-redispatch");
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute("aria-label", expect.stringMatching(/PR-2b/));
    expect(btn).toHaveAttribute("data-can-redispatch", "yes");
  });

  it("renders the Redispatch button DISABLED even on a running row (PR-2b ships the actual route)", () => {
    activeWorkItemState.activeWorkItem = workItem({ status: "running" });
    render(
      <WorkItemPanel
        pipelineId="p1"
        initialState={makeState(activeWorkItemState.activeWorkItem)}
      />,
    );
    const btn = screen.getByTestId("work-item-redispatch");
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute("data-can-redispatch", "no");
  });

  it("renders the Cancel pipeline button (reused CancelPipelineButton)", () => {
    activeWorkItemState.activeWorkItem = workItem({ status: "running" });
    render(
      <WorkItemPanel
        pipelineId="p1"
        initialState={makeState(activeWorkItemState.activeWorkItem)}
      />,
    );
    expect(screen.getByRole("button", { name: /cancel pipeline/i })).toBeInTheDocument();
  });
});

describe("WorkItemPanel — daemon health embedded", () => {
  it("mounts a DaemonHealthBadge alongside the work_item", () => {
    daemonState.consumer = {
      id: "operator-daemon-1",
      kind: "operator_dispatch",
      status: "live",
      startup_check: { auth: "ok" },
      last_seen_at: new Date().toISOString(),
      image_tag: "operator:1.2.3",
      hostname: "operator-1",
      created_at: "2026-05-26T11:00:00Z",
      updated_at: new Date().toISOString(),
    };
    daemonState.freshness = "live";
    activeWorkItemState.activeWorkItem = workItem({ status: "running" });
    render(
      <WorkItemPanel
        pipelineId="p1"
        initialState={makeState(activeWorkItemState.activeWorkItem)}
      />,
    );
    expect(screen.getByTestId("daemon-health-badge")).toHaveAttribute("data-freshness", "live");
  });
});
