/**
 * Tests for the per-creative gate sub-state pill. Pure presentation, so we
 * cover every state's label + colour + icon, the spinner on in_progress, the
 * label/title overrides, and the className passthrough.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SubStatePill, type SubState } from "./SubStatePill";

const ALL_STATES: SubState[] = [
  "pending",
  "in_progress",
  "passed",
  "failed",
  "overridden",
  "skipped",
];

const EXPECTED_LABEL: Record<SubState, string> = {
  pending: "Pending",
  in_progress: "In progress",
  passed: "Passed",
  failed: "Failed",
  overridden: "Overridden",
  skipped: "Skipped",
};

describe("SubStatePill", () => {
  it.each(ALL_STATES)("renders the humanized label for %s", (status) => {
    render(<SubStatePill status={status} />);
    expect(screen.getByText(EXPECTED_LABEL[status])).toBeInTheDocument();
  });

  it.each(ALL_STATES)("exposes the status via data-status for %s", (status) => {
    render(<SubStatePill status={status} />);
    expect(screen.getByTestId("sub-state-pill")).toHaveAttribute("data-status", status);
  });

  it("colours passed emerald", () => {
    render(<SubStatePill status="passed" />);
    expect(screen.getByTestId("sub-state-pill").className).toContain("emerald");
  });

  it("colours failed rose", () => {
    render(<SubStatePill status="failed" />);
    expect(screen.getByTestId("sub-state-pill").className).toContain("rose");
  });

  it("colours overridden amber", () => {
    render(<SubStatePill status="overridden" />);
    expect(screen.getByTestId("sub-state-pill").className).toContain("amber");
  });

  it("colours in_progress sky", () => {
    render(<SubStatePill status="in_progress" />);
    expect(screen.getByTestId("sub-state-pill").className).toContain("sky");
  });

  it("renders neutral (muted) classes for pending and skipped", () => {
    const { rerender } = render(<SubStatePill status="pending" />);
    expect(screen.getByTestId("sub-state-pill").className).toContain("muted");
    rerender(<SubStatePill status="skipped" />);
    expect(screen.getByTestId("sub-state-pill").className).toContain("muted");
  });

  it("spins the icon only for in_progress", () => {
    const { container, rerender } = render(<SubStatePill status="in_progress" />);
    expect(container.querySelector(".animate-spin")).not.toBeNull();
    rerender(<SubStatePill status="passed" />);
    expect(container.querySelector(".animate-spin")).toBeNull();
  });

  it("marks the icon aria-hidden so the label carries meaning", () => {
    const { container } = render(<SubStatePill status="passed" />);
    expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });

  it("uses a custom label when provided", () => {
    render(<SubStatePill status="passed" label="QA OK" />);
    expect(screen.getByText("QA OK")).toBeInTheDocument();
    expect(screen.queryByText("Passed")).not.toBeInTheDocument();
  });

  it("defaults the title to the visible label", () => {
    render(<SubStatePill status="failed" />);
    expect(screen.getByTestId("sub-state-pill")).toHaveAttribute("title", "Failed");
  });

  it("uses an explicit title (e.g. an override note) when provided", () => {
    render(<SubStatePill status="overridden" title="cleared by manager: legal ok" />);
    expect(screen.getByTestId("sub-state-pill")).toHaveAttribute(
      "title",
      "cleared by manager: legal ok",
    );
  });

  it("appends a custom className", () => {
    render(<SubStatePill status="passed" className="custom-extra" />);
    expect(screen.getByTestId("sub-state-pill").className).toContain("custom-extra");
  });
});
