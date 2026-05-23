/**
 * Tests for the rollup progress chip. Pure presentation, so we cover the
 * "N of M cleared" text, every tone (cleared/pending/blocked), the blocked
 * suffix, count clamping, and the className passthrough.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { RollupChip } from "./RollupChip";

describe("RollupChip", () => {
  it("renders the 'N of M cleared' summary", () => {
    render(<RollupChip total={5} cleared={3} blocked={0} pending={2} />);
    expect(screen.getByTestId("rollup-chip")).toHaveTextContent("3 of 5 cleared");
  });

  it("is emerald (cleared) when every creative is cleared", () => {
    render(<RollupChip total={4} cleared={4} blocked={0} pending={0} />);
    const chip = screen.getByTestId("rollup-chip");
    expect(chip).toHaveAttribute("data-tone", "cleared");
    expect(chip.className).toContain("emerald");
  });

  it("is amber (pending) when work is outstanding but nothing is blocked", () => {
    render(<RollupChip total={4} cleared={1} blocked={0} pending={3} />);
    const chip = screen.getByTestId("rollup-chip");
    expect(chip).toHaveAttribute("data-tone", "pending");
    expect(chip.className).toContain("amber");
  });

  it("is amber (pending) when not all cleared even with zero pending count", () => {
    // cleared < total but pending=0 (e.g. counts not yet summed for the rest)
    render(<RollupChip total={4} cleared={2} blocked={0} pending={0} />);
    expect(screen.getByTestId("rollup-chip")).toHaveAttribute("data-tone", "pending");
  });

  it("is rose (blocked) when any creative is blocked, regardless of pending", () => {
    render(<RollupChip total={5} cleared={2} blocked={1} pending={2} />);
    const chip = screen.getByTestId("rollup-chip");
    expect(chip).toHaveAttribute("data-tone", "blocked");
    expect(chip.className).toContain("rose");
  });

  it("shows the blocked suffix only when blocked > 0", () => {
    const { rerender } = render(<RollupChip total={5} cleared={2} blocked={2} pending={1} />);
    expect(screen.getByTestId("rollup-chip")).toHaveTextContent("2 blocked");
    rerender(<RollupChip total={5} cleared={5} blocked={0} pending={0} />);
    expect(screen.getByTestId("rollup-chip")).not.toHaveTextContent("blocked");
  });

  it("puts the full label (with blocked count) in the title", () => {
    render(<RollupChip total={5} cleared={2} blocked={1} pending={2} />);
    expect(screen.getByTestId("rollup-chip")).toHaveAttribute("title", "2 of 5 cleared, 1 blocked");
  });

  it("clamps negative counts to zero", () => {
    render(<RollupChip total={-3} cleared={-1} blocked={-2} pending={-1} />);
    const chip = screen.getByTestId("rollup-chip");
    expect(chip).toHaveTextContent("0 of 0 cleared");
    expect(chip).toHaveAttribute("data-tone", "cleared");
  });

  it("clamps cleared to never exceed total", () => {
    render(<RollupChip total={3} cleared={10} blocked={0} pending={0} />);
    expect(screen.getByTestId("rollup-chip")).toHaveTextContent("3 of 3");
  });

  it("floors fractional counts", () => {
    render(<RollupChip total={4.9} cleared={2.7} blocked={0} pending={2} />);
    expect(screen.getByTestId("rollup-chip")).toHaveTextContent("2 of 4");
  });

  it("renders the icon aria-hidden", () => {
    const { container } = render(<RollupChip total={3} cleared={3} blocked={0} pending={0} />);
    expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });

  it("appends a custom className", () => {
    render(<RollupChip total={3} cleared={3} blocked={0} pending={0} className="custom-extra" />);
    expect(screen.getByTestId("rollup-chip").className).toContain("custom-extra");
  });
});
