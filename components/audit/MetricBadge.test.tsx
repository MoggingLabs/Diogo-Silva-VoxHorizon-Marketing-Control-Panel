/**
 * Tests for the verdict pill. Pure presentation, so we cover each of the
 * three verdicts + the null/unknown fallback.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { MetricBadge } from "./MetricBadge";

describe("MetricBadge", () => {
  it("renders the dash + tooltip for null verdict", () => {
    render(<MetricBadge verdict={null} />);

    const badge = screen.getByText("—");
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveAttribute("title", "No verdict computed yet");
  });

  it("renders the kill label and dot", () => {
    const { container } = render(<MetricBadge verdict="kill" />);

    expect(screen.getByText("Kill")).toBeInTheDocument();
    expect(container.querySelector(".bg-rose-500")).not.toBeNull();
  });

  it("renders the watch label and dot", () => {
    const { container } = render(<MetricBadge verdict="watch" />);

    expect(screen.getByText("Watch")).toBeInTheDocument();
    expect(container.querySelector(".bg-amber-500")).not.toBeNull();
  });

  it("renders the keep label and dot", () => {
    const { container } = render(<MetricBadge verdict="keep" />);

    expect(screen.getByText("Keep")).toBeInTheDocument();
    expect(container.querySelector(".bg-emerald-500")).not.toBeNull();
  });

  it("uses the explicit reason as the tooltip when provided", () => {
    render(<MetricBadge verdict="kill" reason="spend > $75 with no leads" />);

    expect(screen.getByText("Kill").closest("span")).toHaveAttribute(
      "title",
      "spend > $75 with no leads",
    );
  });

  it("falls back to the verdict label as the tooltip when reason is missing", () => {
    render(<MetricBadge verdict="watch" />);

    expect(screen.getByText("Watch").closest("span")).toHaveAttribute("title", "Watch");
  });

  it("appends a custom className when provided", () => {
    const { container } = render(<MetricBadge verdict="keep" className="custom-extra" />);

    expect(container.querySelector(".custom-extra")).not.toBeNull();
  });

  it("appends a custom className to the unknown pill as well", () => {
    const { container } = render(<MetricBadge verdict={null} className="custom-extra" />);

    expect(container.querySelector(".custom-extra")).not.toBeNull();
  });
});
