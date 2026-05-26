/**
 * Tests for the funnel KPI tile primitive. It's pure presentation, so we
 * focus on:
 *   - rendering the label/value combination,
 *   - locale-formatting the primary number,
 *   - hiding/showing the optional breakdown,
 *   - handling the delta placeholder vs a real value (with sign prefix).
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { MetricTile } from "./MetricTile";

describe("MetricTile", () => {
  it("renders the label, locale-formatted value, and the delta placeholder when delta is null", () => {
    render(<MetricTile label="In Brief" value={12345} delta={null} />);

    expect(screen.getByText("In Brief")).toBeInTheDocument();
    expect(screen.getByText("12,345")).toBeInTheDocument();
    expect(screen.getByText("No change data")).toBeInTheDocument();
  });

  it("renders a positive delta with a + prefix", () => {
    render(<MetricTile label="Live" value={5} delta={3} />);

    expect(screen.getByText("+3 today")).toBeInTheDocument();
  });

  it("renders a zero delta with a + prefix (0 is non-negative)", () => {
    render(<MetricTile label="Live" value={5} delta={0} />);

    expect(screen.getByText("+0 today")).toBeInTheDocument();
  });

  it("renders a negative delta without a + (the minus sign already comes from the number)", () => {
    render(<MetricTile label="Killed" value={2} delta={-4} />);

    expect(screen.getByText("-4 today")).toBeInTheDocument();
  });

  it("renders the breakdown row when items are provided", () => {
    render(
      <MetricTile
        label="In Creative"
        value={9}
        breakdown={[
          { label: "Image", value: 5 },
          { label: "Video", value: 4 },
        ]}
      />,
    );

    expect(screen.getByText("Image 5 · Video 4")).toBeInTheDocument();
  });

  it("does not render the breakdown row when the array is empty", () => {
    const { container } = render(<MetricTile label="Live" value={0} breakdown={[]} />);

    expect(
      container.querySelector("span.text-\\[11px\\].text-muted-foreground.sm\\:text-xs"),
    ).toBeTruthy();
    // breakdown text content shouldn't show
    expect(screen.queryByText(/Image/i)).not.toBeInTheDocument();
  });

  it("falls back to the default accent class when none is supplied", () => {
    const { container } = render(<MetricTile label="Live" value={1} />);

    // Default accent: the neutral muted-foreground token.
    expect(container.querySelector(".bg-muted-foreground")).not.toBeNull();
  });

  it("applies a custom accent class when provided", () => {
    const { container } = render(
      <MetricTile label="Live" value={1} accentClass="bg-emerald-500" />,
    );

    expect(container.querySelector(".bg-emerald-500")).not.toBeNull();
  });
});
