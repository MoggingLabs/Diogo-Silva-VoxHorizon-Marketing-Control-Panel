import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ApprovalArgsDiff } from "./ApprovalArgsDiff";

describe("ApprovalArgsDiff", () => {
  it("renders an empty state for null/undefined args", () => {
    render(<ApprovalArgsDiff args={null} />);
    expect(screen.getByTestId("args-empty")).toHaveTextContent(/no arguments/i);
  });

  it("renders an empty state for an empty object", () => {
    render(<ApprovalArgsDiff args={{}} />);
    expect(screen.getByTestId("args-empty")).toBeInTheDocument();
  });

  it("renders the diff container with each leaf path", () => {
    render(<ApprovalArgsDiff args={{ a: 1, b: "two" }} />);
    const paths = screen
      .getAllByTestId("leaf-path")
      .map((el) => el.textContent)
      .sort();
    expect(paths).toEqual(["a", "b"]);
  });

  it("renders a path-highlighted span for path values", () => {
    render(<ApprovalArgsDiff args={{ p: "/var/log" }} />);
    // Locate by the kind-tagged data-testid so the assertion survives a
    // palette change (M8 swapped the literal yellow/sky/red classes for
    // semantic warning/info/destructive tokens that read correctly in dark
    // mode). The rendered text + role / testid is the durable contract.
    const highlight = screen.getByTestId("leaf-value-path");
    expect(highlight).toHaveTextContent("/var/log");
    expect(highlight.className).toMatch(/warning/);
  });

  it("renders a URL-highlighted span for URL values", () => {
    render(<ApprovalArgsDiff args={{ u: "https://example.com" }} />);
    const highlight = screen.getByTestId("leaf-value-url");
    expect(highlight).toHaveTextContent("https://example.com");
    expect(highlight.className).toMatch(/info/);
  });

  it("renders a money-highlighted span for money values", () => {
    render(<ApprovalArgsDiff args={{ cost: 200 }} />);
    const highlight = screen.getByTestId("leaf-value-money");
    expect(highlight).toHaveTextContent("200");
    expect(highlight.className).toMatch(/destructive/);
  });

  it("nested objects appear with dot-path keys", () => {
    render(<ApprovalArgsDiff args={{ outer: { inner: "ok" } }} />);
    const paths = screen.getAllByTestId("leaf-path").map((el) => el.textContent);
    expect(paths).toContain("outer.inner");
  });

  it("arrays appear with bracket indices", () => {
    render(<ApprovalArgsDiff args={{ list: ["x", "y"] }} />);
    const paths = screen.getAllByTestId("leaf-path").map((el) => el.textContent);
    expect(paths).toContain("list[0]");
    expect(paths).toContain("list[1]");
  });

  it("plain leaves carry no highlight background", () => {
    render(<ApprovalArgsDiff args={{ note: "hello" }} />);
    const highlight = screen.getByText("hello");
    expect(highlight.className).toMatch(/foreground/);
    // No path / url / money tinting on a plain string.
    expect(highlight.className).not.toMatch(/warning|info|destructive/);
  });

  it("never uses dangerouslySetInnerHTML even for script-like strings", () => {
    render(<ApprovalArgsDiff args={{ payload: "<script>alert(1)</script>" }} />);
    // Should be rendered as plain text content — the DOM contains the
    // literal string, not a <script> element.
    expect(screen.queryByText("<script>alert(1)</script>")).toBeInTheDocument();
    expect(document.querySelector("script")).toBeNull();
  });
});
