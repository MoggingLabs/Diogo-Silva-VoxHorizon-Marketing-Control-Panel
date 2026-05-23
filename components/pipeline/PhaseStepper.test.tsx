/**
 * PhaseStepper (#356): 5-phase clustered stepper. Covers phase past/active/
 * future state, the active stage highlight, every legacy status mapping to a
 * phase (strangler-fig), and the cancelled escape.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { PhaseStepper } from "./PhaseStepper";
import type { PipelineStatus } from "@/lib/pipeline/types";

const ALL: PipelineStatus[] = [
  "configuration",
  "ideation",
  "review",
  "generation",
  "creative_qa",
  "compliance_review",
  "copy",
  "spec_validation",
  "variant_plan",
  "finalize_assets",
  "launch_handoff",
  "monitor",
  "done",
  "cancelled",
];

describe("PhaseStepper", () => {
  it.each(ALL)("renders every legacy status %s without gaps", (status) => {
    render(<PhaseStepper current={status} />);
    expect(screen.getByTestId("phase-stepper")).toBeInTheDocument();
    // All five forward phases + closed are always present.
    for (const p of ["define", "create", "vet", "pack", "live", "closed"]) {
      expect(screen.getByTestId(`phase-${p}`)).toBeInTheDocument();
    }
  });

  it("marks the active phase from the current status", () => {
    render(<PhaseStepper current="copy" />);
    expect(screen.getByTestId("phase-stepper")).toHaveAttribute("data-active-phase", "vet");
    expect(screen.getByTestId("phase-vet")).toHaveAttribute("data-state", "active");
  });

  it("marks earlier phases past and later phases future", () => {
    render(<PhaseStepper current="variant_plan" />);
    expect(screen.getByTestId("phase-define")).toHaveAttribute("data-state", "past");
    expect(screen.getByTestId("phase-vet")).toHaveAttribute("data-state", "past");
    expect(screen.getByTestId("phase-pack")).toHaveAttribute("data-state", "active");
    expect(screen.getByTestId("phase-live")).toHaveAttribute("data-state", "future");
  });

  it("highlights the active stage chip", () => {
    render(<PhaseStepper current="compliance_review" />);
    expect(screen.getByTestId("phase-stage-compliance_review")).toHaveAttribute(
      "data-current",
      "true",
    );
  });

  it("places cancelled in the closed phase", () => {
    render(<PhaseStepper current="cancelled" />);
    expect(screen.getByTestId("phase-stepper")).toHaveAttribute("data-active-phase", "closed");
    expect(screen.getByTestId("phase-stage-cancelled")).toHaveAttribute("data-current", "true");
  });
});
