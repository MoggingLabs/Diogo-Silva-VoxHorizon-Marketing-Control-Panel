/**
 * CostBreakdownTable renders one row per estimate item plus a total.
 * Adds an Actual column when `actual` is provided.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { Estimate } from "@/lib/cost-estimator";

import { CostBreakdownTable } from "./CostBreakdownTable";

const emptyEstimate: Estimate = { items: [], total: 0 };

const fullEstimate: Estimate = {
  items: [
    {
      api: "anthropic",
      unit_label: "1k tokens",
      units: 5,
      unit_cost: 0.03,
      subtotal: 0.15,
    },
    {
      api: "elevenlabs",
      unit_label: "1k chars",
      units: 0.8,
      unit_cost: 0.18,
      subtotal: 0.144,
    },
  ],
  total: 0.294,
};

describe("CostBreakdownTable", () => {
  it("renders the empty-state when items is empty", () => {
    render(<CostBreakdownTable estimate={emptyEstimate} />);
    expect(screen.getByText("No cost yet")).toBeInTheDocument();
  });

  it("uses the custom emptyMessage when provided", () => {
    render(<CostBreakdownTable estimate={emptyEstimate} emptyMessage="Nothing yet" />);
    expect(screen.getByText("Nothing yet")).toBeInTheDocument();
  });

  it("renders one row per item with formatted currency + units", () => {
    render(<CostBreakdownTable estimate={fullEstimate} />);
    expect(screen.getByText("anthropic")).toBeInTheDocument();
    expect(screen.getByText("elevenlabs")).toBeInTheDocument();
    // Integer-ish 5 stays integer, 0.8 keeps decimals.
    expect(screen.getByText("5")).toBeInTheDocument();
    expect(screen.getByText("0.80")).toBeInTheDocument();
  });

  it("renders the Total row with the formatted grand total", () => {
    render(<CostBreakdownTable estimate={fullEstimate} />);
    expect(screen.getByText("Total")).toBeInTheDocument();
    expect(screen.getAllByText(/\$0\.29/).length).toBeGreaterThan(0);
  });

  it("adds an Actual column when actual estimate is provided", () => {
    const actual: Estimate = {
      items: [
        {
          api: "anthropic",
          unit_label: "1k tokens",
          units: 5,
          unit_cost: 0.03,
          subtotal: 0.2,
        },
      ],
      total: 0.2,
    };
    render(<CostBreakdownTable estimate={fullEstimate} actual={actual} />);
    expect(screen.getByText("Actual")).toBeInTheDocument();
    // anthropic actual matches; elevenlabs has no actual → em-dash.
    expect(screen.getByText("—")).toBeInTheDocument();
  });
});
