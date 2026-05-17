/**
 * Tests for the funnel header. It composes MetricTile + StackedBar from
 * `counts` and the active `format`, so we exercise:
 *   - Each format ("image" / "video" / "both") selects the right counts source.
 *   - "both" exposes the per-format breakdown inline.
 *   - All six funnel stages render as tiles.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { FunnelHeader } from "./FunnelHeader";
import { zeroCounts } from "@/lib/dashboard-types";

const counts = {
  image: { ...zeroCounts(), in_brief: 3, live: 7 },
  video: { ...zeroCounts(), in_brief: 4, live: 2 },
  combined: { ...zeroCounts(), in_brief: 7, live: 9 },
};

describe("FunnelHeader", () => {
  it("renders all six funnel stage labels as tiles", () => {
    render(<FunnelHeader format="both" counts={counts} />);

    // Each stage label appears in both the tile and the stacked-bar legend.
    expect(screen.getAllByText("In Brief").length).toBeGreaterThan(0);
    expect(screen.getAllByText("In Creative").length).toBeGreaterThan(0);
    expect(screen.getAllByText("In Copy").length).toBeGreaterThan(0);
    expect(screen.getAllByText("In Launch").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Live").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Killed").length).toBeGreaterThan(0);
  });

  it("uses image counts when format=image", () => {
    render(<FunnelHeader format="image" counts={counts} />);

    // The tile primary value is the image count, no breakdown is shown.
    expect(screen.getAllByText("3")[0]).toBeInTheDocument();
    expect(screen.getAllByText("7")[0]).toBeInTheDocument();
    // No "Image 3 · Video 4" composite line when single-format.
    expect(screen.queryByText(/Image 3 · Video 4/)).not.toBeInTheDocument();
  });

  it("uses video counts when format=video", () => {
    render(<FunnelHeader format="video" counts={counts} />);

    expect(screen.getAllByText("4")[0]).toBeInTheDocument();
    expect(screen.getAllByText("2")[0]).toBeInTheDocument();
  });

  it("renders the per-format breakdown when format=both", () => {
    render(<FunnelHeader format="both" counts={counts} />);

    // The combined value (in_brief = 7) gets the breakdown line below it.
    expect(screen.getByText(/Image 3 · Video 4/)).toBeInTheDocument();
    // And `live`: combined 9, image 7, video 2.
    expect(screen.getByText(/Image 7 · Video 2/)).toBeInTheDocument();
  });

  it("renders the stacked bar title with the combined total", () => {
    render(<FunnelHeader format="both" counts={counts} />);

    expect(screen.getByText("Lifecycle distribution")).toBeInTheDocument();
    // 7 + 9 = 16
    expect(screen.getByText("16 total")).toBeInTheDocument();
  });
});
