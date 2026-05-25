/**
 * Tests for the audit funnel Sankey diagram. The component is pure SVG output
 * and is rendered as a server component (no client hooks), so jsdom rendering
 * gives us full coverage of the geometry helpers via inspection of the DOM.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { FunnelSankey } from "./FunnelSankey";

describe("FunnelSankey", () => {
  it("renders the Sankey SVG with a stage label per funnel stage", () => {
    render(
      <FunnelSankey
        totals={{
          impressions: 1000,
          clicks: 200,
          leads: 50,
          booked: 0,
          showed: 0,
          sold: 0,
        }}
      />,
    );

    expect(screen.getByText("Impressions")).toBeInTheDocument();
    expect(screen.getByText("Clicks")).toBeInTheDocument();
    expect(screen.getByText("Leads")).toBeInTheDocument();
    expect(screen.getByText("Booked")).toBeInTheDocument();
    expect(screen.getByText("Showed")).toBeInTheDocument();
    expect(screen.getByText("Sold")).toBeInTheDocument();
  });

  it("shows the empty-state overlay when every stage is zero", () => {
    render(
      <FunnelSankey
        totals={{
          impressions: 0,
          clicks: 0,
          leads: 0,
          booked: 0,
          showed: 0,
          sold: 0,
        }}
      />,
    );

    expect(
      screen.getByText(/No funnel data yet - waiting for the worker pull\./),
    ).toBeInTheDocument();
  });

  it("does NOT show the empty-state overlay when at least one stage is non-zero", () => {
    render(
      <FunnelSankey
        totals={{
          impressions: 100,
          clicks: 0,
          leads: 0,
          booked: 0,
          showed: 0,
          sold: 0,
        }}
      />,
    );

    expect(screen.queryByText(/No funnel data yet/)).not.toBeInTheDocument();
  });

  it("formats large stage counts with K/M suffixes", () => {
    render(
      <FunnelSankey
        totals={{
          impressions: 2_500_000,
          clicks: 50_000,
          leads: 999,
          booked: 0,
          showed: 0,
          sold: 0,
        }}
      />,
    );

    expect(screen.getByText("2.5M")).toBeInTheDocument();
    expect(screen.getByText("50.0K")).toBeInTheDocument();
    expect(screen.getByText("999")).toBeInTheDocument();
  });

  it("renders conversion rate labels between stages", () => {
    render(
      <FunnelSankey
        totals={{
          impressions: 1000,
          clicks: 100,
          leads: 10,
          booked: 0,
          showed: 0,
          sold: 0,
        }}
      />,
    );

    // 100/1000 = 10.0%, 10/100 = 10.0%, 0/10 = 0.0%
    const tenPct = screen.getAllByText("10.0%");
    expect(tenPct.length).toBeGreaterThanOrEqual(2);
  });

  it("renders an em-dash for conversion rate when upstream is zero", () => {
    render(
      <FunnelSankey
        totals={{
          impressions: 0,
          clicks: 5,
          leads: 5,
          booked: 0,
          showed: 0,
          sold: 0,
        }}
      />,
    );

    // 0 → anything renders '—'
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });

  it("renders the Sankey ribbons as svg <path> elements", () => {
    const { container } = render(
      <FunnelSankey
        totals={{
          impressions: 100,
          clicks: 50,
          leads: 10,
          booked: 5,
          showed: 2,
          sold: 1,
        }}
      />,
    );

    // 5 transitions between 6 stages.
    const paths = container.querySelectorAll("svg path");
    expect(paths).toHaveLength(5);
  });
});
