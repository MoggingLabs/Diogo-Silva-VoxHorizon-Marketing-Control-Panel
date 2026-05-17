/**
 * Tests for the stacked-bar primitive.
 *
 * The bar's contract:
 *   - When total > 0, each segment renders a div with width proportional to its share.
 *   - Zero-value segments are skipped from the bar but still appear in the legend.
 *   - When total is 0, only the empty rail renders, and the aria-label changes.
 *   - The optional title block shows the total.
 *   - The legend can be hidden via `showLegend={false}`.
 */
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { StackedBar, type StackedBarSegment } from "./StackedBar";

const SAMPLE: StackedBarSegment[] = [
  { key: "in_brief", label: "In Brief", value: 5, className: "bg-zinc-300" },
  { key: "live", label: "Live", value: 15, className: "bg-emerald-500" },
];

describe("StackedBar", () => {
  it("renders the title and locale-formatted total when a title is provided", () => {
    render(<StackedBar segments={SAMPLE} title="Lifecycle distribution" />);

    expect(screen.getByText("Lifecycle distribution")).toBeInTheDocument();
    expect(screen.getByText("20 total")).toBeInTheDocument();
  });

  it("omits the title row entirely when no title is provided", () => {
    render(<StackedBar segments={SAMPLE} />);

    expect(screen.queryByText("Lifecycle distribution")).not.toBeInTheDocument();
    // The total badge ("20 total") only appears next to the title — verify it's gone too.
    expect(screen.queryByText("20 total")).not.toBeInTheDocument();
  });

  it("uses the populated aria-label when there is data", () => {
    render(<StackedBar segments={SAMPLE} />);

    expect(
      screen.getByRole("img", {
        name: /Funnel breakdown: In Brief 5, Live 15/,
      }),
    ).toBeInTheDocument();
  });

  it("uses the empty aria-label when every segment is zero", () => {
    render(
      <StackedBar
        segments={[
          { key: "a", label: "A", value: 0, className: "bg-zinc-100" },
          { key: "b", label: "B", value: 0, className: "bg-zinc-100" },
        ]}
      />,
    );

    expect(screen.getByRole("img", { name: /no data yet/i })).toBeInTheDocument();
  });

  it("excludes zero-value segments from the fill but keeps them in the legend", () => {
    const segments: StackedBarSegment[] = [
      { key: "a", label: "Alpha", value: 0, className: "bg-zinc-300" },
      { key: "b", label: "Beta", value: 10, className: "bg-emerald-500" },
    ];

    const { container } = render(<StackedBar segments={segments} />);

    // Both labels are visible in the legend.
    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(screen.getByText("Beta")).toBeInTheDocument();

    // But only one segment fill is rendered inside the bar rail (the role=img wrapper).
    const rail = container.querySelector('[role="img"]') as HTMLElement;
    // Children of the rail are the fills (segments with value > 0).
    const fills = within(rail).queryAllByTitle(/.+/);
    expect(fills).toHaveLength(1);
    expect(fills[0]).toHaveAttribute("title", expect.stringContaining("Beta"));
  });

  it("hides the legend when showLegend is false", () => {
    render(<StackedBar segments={SAMPLE} showLegend={false} />);

    expect(screen.queryByText("In Brief")).not.toBeInTheDocument();
    expect(screen.queryByText("Live")).not.toBeInTheDocument();
  });

  it("sets segment width via flex style proportional to share of total", () => {
    const { container } = render(<StackedBar segments={SAMPLE} />);

    const live = container.querySelector('[title^="Live"]') as HTMLElement;
    expect(live).toBeTruthy();
    // 15 / 20 = 75%
    expect(live.style.flex).toContain("75");
  });
});
