/**
 * OperatorNarration renders a plain-language feed derived from
 * pipeline_events. We stub `usePipelineEvents` (its own unit) to return the
 * seed list and assert the narration translation + empty state.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { PipelineEvent } from "@/lib/pipeline/types";

// Return whatever seed we hand the component, like the StageGeneration spec.
vi.mock("@/hooks/usePipelineEvents", () => ({
  usePipelineEvents: (_id: string, seed: PipelineEvent[]) => seed,
}));

import { OperatorNarration } from "./OperatorNarration";

let seq = 0;
function ev(partial: Partial<PipelineEvent> & { kind: string }): PipelineEvent {
  seq += 1;
  return {
    id: partial.id ?? `e${seq}`,
    pipeline_id: "p1",
    kind: partial.kind,
    stage: partial.stage ?? null,
    payload: partial.payload ?? {},
    created_at: partial.created_at ?? `2026-05-20T00:00:0${seq % 10}.000Z`,
  };
}

describe("OperatorNarration", () => {
  it("shows the empty state when there are no narratable events", () => {
    render(<OperatorNarration pipelineId="p1" initialEvents={[]} />);
    expect(screen.getByTestId("operator-narration-empty")).toBeInTheDocument();
  });

  it("treats events with no manager meaning as empty", () => {
    // configuration bootstrap + picks_recorded are both filtered out.
    render(
      <OperatorNarration
        pipelineId="p1"
        initialEvents={[
          ev({ kind: "stage_advanced", stage: "configuration" }),
          ev({ kind: "task_done", payload: { action: "picks_recorded" } }),
        ]}
      />,
    );
    expect(screen.getByTestId("operator-narration-empty")).toBeInTheDocument();
  });

  it("renders narration lines newest-first", () => {
    render(
      <OperatorNarration
        pipelineId="p1"
        initialEvents={[
          ev({
            kind: "operator_dispatched",
            stage: "configuration",
            payload: { reason: "kickoff" },
            created_at: "2026-05-20T00:00:00.000Z",
          }),
          ev({
            kind: "brief_authored",
            payload: { notes: "lean into savings" },
            created_at: "2026-05-20T00:01:00.000Z",
          }),
          ev({
            kind: "cost_recorded",
            payload: { subtotal: 0.05 },
            created_at: "2026-05-20T00:02:00.000Z",
          }),
        ]}
      />,
    );
    expect(screen.queryByTestId("operator-narration-empty")).not.toBeInTheDocument();
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(3);
    // Newest (cost) first, kickoff last.
    expect(items[0]).toHaveTextContent(/Spend recorded: \$0\.05/);
    expect(items[2]).toHaveTextContent(/hired the operator/i);
    // Notes are surfaced.
    expect(screen.getByText(/lean into savings/)).toBeInTheDocument();
  });

  it("labels the panel as operator narration", () => {
    render(<OperatorNarration pipelineId="p1" initialEvents={[]} />);
    expect(screen.getByRole("region", { name: /operator narration/i })).toBeInTheDocument();
  });
});
