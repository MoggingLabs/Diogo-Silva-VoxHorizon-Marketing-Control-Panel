/**
 * OperatorConsole (E5.3 / #597): active operator runs + selected-run narration
 * + per-stage gate call-to-action + collapsible kickoff.
 */
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mockRealtimeStream } from "@/tests/unit/helpers/realtime-mock";

const routerRefresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: routerRefresh, push: vi.fn(), replace: vi.fn() }),
}));

const realtime = mockRealtimeStream();
vi.mock("@/hooks/useRealtimeStream", () => ({
  useRealtimeStream: (listeners: unknown) =>
    realtime.register(listeners as Parameters<typeof realtime.register>[0]),
}));

vi.mock("@/components/pipeline/OperatorKickoffForm", () => ({
  OperatorKickoffForm: () => <div data-testid="kickoff-form" />,
}));
vi.mock("@/components/pipeline/OperatorNarration", () => ({
  OperatorNarration: ({ pipelineId }: { pipelineId: string }) => (
    <div data-testid="narration" data-pipeline={pipelineId} />
  ),
}));

// Silent-failure PR-2a: the OperatorConsole now mounts a DaemonHealthBadge at
// the top. Stub it so this test stays focused on the runs list / kickoff
// behaviour (DaemonHealthBadge has its own test file).
vi.mock("@/components/pipeline/DaemonHealthBadge", () => ({
  DaemonHealthBadge: () => <div data-testid="daemon-health-badge-stub" />,
}));

import { OperatorConsole } from "./OperatorConsole";
import type { OperatorRun } from "@/lib/operator/console";

function run(overrides: Partial<OperatorRun> = {}): OperatorRun {
  return {
    id: "p1",
    status: "generation",
    format_choice: "image",
    client_id: "c1",
    clientName: "Acme Roofing",
    created_at: "2026-05-26T00:00:00Z",
    updated_at: "2026-05-26T01:00:00Z",
    events: [],
    dispatchStatus: null,
    ...overrides,
  };
}

beforeEach(() => routerRefresh.mockReset());
afterEach(() => vi.restoreAllMocks());

describe("OperatorConsole", () => {
  it("shows an empty state + open kickoff when there are no runs", () => {
    render(<OperatorConsole initialRuns={[]} />);
    expect(screen.getByText(/No active operator runs/i)).toBeInTheDocument();
    // Kickoff defaults open when there are no runs.
    expect(screen.getByTestId("kickoff-form")).toBeInTheDocument();
  });

  it("lists active runs with status + stage and seeds narration for the first", () => {
    render(
      <OperatorConsole
        initialRuns={[
          run({ id: "p1", clientName: "Acme Roofing" }),
          run({ id: "p2", clientName: "Beta" }),
        ]}
      />,
    );
    expect(screen.getByTestId("operator-runs").children).toHaveLength(2);
    expect(
      within(screen.getByTestId("operator-run-p1")).getByText("Acme Roofing"),
    ).toBeInTheDocument();
    // First run is selected by default -> its narration is mounted.
    expect(screen.getByTestId("narration")).toHaveAttribute("data-pipeline", "p1");
  });

  it("renders a gate call-to-action for a gate stage", () => {
    render(<OperatorConsole initialRuns={[run({ id: "p1", status: "launch_handoff" })]} />);
    const row = screen.getByTestId("operator-run-p1");
    expect(within(row).getByText(/Launch gate awaiting approval/i)).toBeInTheDocument();
    expect(within(row).getByRole("link", { name: /review & decide/i })).toHaveAttribute(
      "href",
      "/pipeline/p1",
    );
  });

  it("switches the narration feed when another run is selected", async () => {
    const user = userEvent.setup();
    render(
      <OperatorConsole
        initialRuns={[run({ id: "p1", clientName: "Acme" }), run({ id: "p2", clientName: "Beta" })]}
      />,
    );
    expect(screen.getByTestId("narration")).toHaveAttribute("data-pipeline", "p1");
    await user.click(screen.getByRole("button", { name: /select run beta/i }));
    expect(screen.getByTestId("narration")).toHaveAttribute("data-pipeline", "p2");
  });

  it("collapses + expands the kickoff section", async () => {
    const user = userEvent.setup();
    render(<OperatorConsole initialRuns={[run()]} />);
    // With runs present, kickoff starts collapsed.
    expect(screen.queryByTestId("kickoff-form")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /hire the operator/i }));
    expect(screen.getByTestId("kickoff-form")).toBeInTheDocument();
  });

  it("mounts a DaemonHealthBadge at the top (silent-failure PR-2a)", () => {
    render(<OperatorConsole initialRuns={[run()]} />);
    expect(screen.getByTestId("operator-console-daemon")).toBeInTheDocument();
    expect(screen.getByTestId("daemon-health-badge-stub")).toBeInTheDocument();
  });

  it("renders a mini dispatch pill per run when dispatchStatus is set", () => {
    render(<OperatorConsole initialRuns={[run({ id: "p1", dispatchStatus: "running" })]} />);
    const pill = screen.getByTestId("operator-run-p1-dispatch");
    expect(pill).toBeInTheDocument();
    expect(pill).toHaveTextContent(/running/i);
  });

  it("renders the idle dispatch pill when there is no work_item", () => {
    render(<OperatorConsole initialRuns={[run({ id: "p1", dispatchStatus: null })]} />);
    const pill = screen.getByTestId("operator-run-p1-dispatch");
    expect(pill).toBeInTheDocument();
    expect(pill).toHaveTextContent(/idle/i);
  });

  it("subscribes to BOTH pipelines and work_item realtime channels", () => {
    render(<OperatorConsole initialRuns={[run()]} />);
    const tables = new Set(realtime.listeners.map((l) => l.table));
    expect(tables.has("pipelines")).toBe(true);
    expect(tables.has("work_item")).toBe(true);
  });
});
