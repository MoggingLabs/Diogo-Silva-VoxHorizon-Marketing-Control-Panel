/**
 * Tests for the live char counter. Pure presentation over platform-limits, so
 * we cover the ok/warn/error colour thresholds, the recommended-vs-max
 * denominator, the over marker, the unlimited (no-cap) surface, and the
 * placement fallback + className passthrough.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { CharCounter } from "./CharCounter";

describe("CharCounter", () => {
  it("shows count / recommended cap when under the soft cap", () => {
    render(<CharCounter value={"a".repeat(20)} field="headline" platform="meta" />);
    const counter = screen.getByTestId("char-counter");
    expect(counter).toHaveTextContent("20");
    expect(counter).toHaveTextContent("40");
    expect(counter).toHaveAttribute("data-status", "ok");
  });

  it("is muted (ok) at or below recommended", () => {
    render(<CharCounter value={"a".repeat(40)} field="headline" platform="meta" />);
    const counter = screen.getByTestId("char-counter");
    expect(counter).toHaveAttribute("data-status", "ok");
    expect(counter.className).toContain("muted");
  });

  it("turns amber (warn) over the recommended cap", () => {
    render(<CharCounter value={"a".repeat(41)} field="headline" platform="meta" />);
    const counter = screen.getByTestId("char-counter");
    expect(counter).toHaveAttribute("data-status", "warn");
    expect(counter.className).toContain("amber");
  });

  it("turns red (error) over the hard cap and shows the over marker", () => {
    render(<CharCounter value={"a".repeat(256)} field="headline" platform="meta" />);
    const counter = screen.getByTestId("char-counter");
    expect(counter).toHaveAttribute("data-status", "error");
    expect(counter.className).toContain("rose");
    expect(screen.getByTestId("char-counter-over")).toHaveTextContent("-1 over");
  });

  it("does not render the over marker when not in error", () => {
    render(<CharCounter value={"a".repeat(41)} field="headline" platform="meta" />);
    expect(screen.queryByTestId("char-counter-over")).not.toBeInTheDocument();
  });

  it("uses the hard cap as the denominator when there is no recommended", () => {
    // Google RSA headline: max 30, no recommended.
    render(<CharCounter value={"abc"} field="headline" platform="google" />);
    const counter = screen.getByTestId("char-counter");
    expect(counter).toHaveTextContent("3");
    expect(counter).toHaveTextContent("30");
    expect(counter).toHaveAttribute("data-status", "ok");
  });

  it("goes straight ok→error for a no-recommended field over its cap", () => {
    render(<CharCounter value={"a".repeat(31)} field="headline" platform="google" />);
    expect(screen.getByTestId("char-counter")).toHaveAttribute("data-status", "error");
  });

  it("shows only the bare count for an unlimited surface (no published cap)", () => {
    // Google RSA has no primary_text field → unlimited.
    render(<CharCounter value={"a".repeat(500)} field="primary_text" platform="google" />);
    const counter = screen.getByTestId("char-counter");
    expect(counter).toHaveTextContent("500");
    expect(counter).not.toHaveTextContent("/");
    expect(counter).toHaveAttribute("data-status", "ok");
  });

  it("honours an explicit placement (stories has a shorter soft cap)", () => {
    // 71 chars: warn for stories (rec 70) but ok for feed (rec 125).
    render(
      <CharCounter
        value={"a".repeat(71)}
        field="primary_text"
        platform="meta"
        placement="stories"
      />,
    );
    expect(screen.getByTestId("char-counter")).toHaveAttribute("data-status", "warn");
  });

  it("falls back to the default placement when omitted", () => {
    // 71 chars on feed (default) is well under the 125 soft cap → ok.
    render(<CharCounter value={"a".repeat(71)} field="primary_text" platform="meta" />);
    expect(screen.getByTestId("char-counter")).toHaveAttribute("data-status", "ok");
  });

  it("counts an empty value as zero", () => {
    render(<CharCounter value="" field="headline" platform="meta" />);
    expect(screen.getByTestId("char-counter")).toHaveTextContent("0");
  });

  it("appends a custom className", () => {
    render(<CharCounter value="x" field="headline" platform="meta" className="custom-extra" />);
    expect(screen.getByTestId("char-counter").className).toContain("custom-extra");
  });
});
