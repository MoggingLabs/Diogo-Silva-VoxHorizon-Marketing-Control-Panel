/**
 * Tests for the shared card primitives — `CardShell`, `prettyJson`,
 * `pickStringField`, and `StatusPill`. The primitives drive every
 * tool-call card renderer; covering them here keeps the per-card specs
 * focused on what's unique about each tool.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { CardShell, StatusPill, pickStringField, prettyJson } from "./shared";

describe("prettyJson", () => {
  it("renders null/undefined as (null)", () => {
    expect(prettyJson(null)).toBe("(null)");
    expect(prettyJson(undefined)).toBe("(null)");
  });

  it("passes strings through unchanged", () => {
    expect(prettyJson("hello")).toBe("hello");
  });

  it("pretty-prints objects with 2-space indent", () => {
    expect(prettyJson({ a: 1 })).toBe('{\n  "a": 1\n}');
  });

  it("falls back to String() when JSON.stringify throws", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(prettyJson(circular)).toMatch(/\[object Object\]|object/);
  });
});

describe("pickStringField", () => {
  it("returns the fallback for null/undefined input", () => {
    expect(pickStringField(null, ["prompt"])).toBe("(no input yet)");
    expect(pickStringField(undefined, ["prompt"], "custom")).toBe("custom");
  });

  it("returns the trimmed string for a string input", () => {
    expect(pickStringField("  hi  ", ["prompt"])).toBe("hi");
  });

  it("returns fallback when string is empty/whitespace", () => {
    expect(pickStringField("   ", ["prompt"])).toBe("(no input yet)");
  });

  it("truncates very long strings to 117 chars + ellipsis", () => {
    const long = "x".repeat(200);
    const out = pickStringField(long, ["prompt"]);
    expect(out.length).toBe(118);
    expect(out.endsWith("…")).toBe(true);
  });

  it("stringifies non-object, non-string input", () => {
    expect(pickStringField(42, ["prompt"])).toBe("42");
  });

  it("picks the first matching field value from an object", () => {
    expect(pickStringField({ prompt: "draw a cat", other: "x" }, ["prompt"])).toBe("draw a cat");
  });

  it("skips empty/whitespace fields and tries the next one", () => {
    expect(pickStringField({ prompt: "", headline: "go" }, ["prompt", "headline"])).toBe("go");
  });

  it("truncates long object field values too", () => {
    const long = "x".repeat(200);
    expect(pickStringField({ prompt: long }, ["prompt"]).endsWith("…")).toBe(true);
  });

  it("falls back to JSON serialization when no fields match", () => {
    expect(pickStringField({ misc: 1 }, ["prompt"])).toBe('{"misc":1}');
  });
});

describe("CardShell", () => {
  it("renders the tool name, summary, and a pending spinner", () => {
    render(
      <CardShell
        icon={<span data-testid="i" />}
        tool="regen"
        summary="working"
        pending
        input={{ a: 1 }}
        result={null}
      />,
    );
    expect(screen.getByText("regen")).toBeInTheDocument();
    expect(screen.getByText(/working/)).toBeInTheDocument();
    expect(screen.getByTestId("i")).toBeInTheDocument();
  });

  it("expands to show pretty-printed input + result on click", async () => {
    const user = userEvent.setup();
    render(
      <CardShell
        icon={<span />}
        tool="regen"
        summary="done"
        pending={false}
        input={{ prompt: "hi" }}
        result={{ ok: true }}
      />,
    );

    // Collapsed by default — neither label is visible.
    expect(screen.queryByText("Input")).not.toBeInTheDocument();
    expect(screen.queryByText("Result")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { expanded: false }));

    expect(screen.getByText("Input")).toBeInTheDocument();
    expect(screen.getByText("Result")).toBeInTheDocument();
  });

  it("omits the Result block when result is null", async () => {
    const user = userEvent.setup();
    render(
      <CardShell
        icon={<span />}
        tool="regen"
        summary="working"
        pending
        input={{ prompt: "hi" }}
        result={null}
      />,
    );
    await user.click(screen.getByRole("button", { expanded: false }));
    expect(screen.getByText("Input")).toBeInTheDocument();
    expect(screen.queryByText("Result")).not.toBeInTheDocument();
  });

  it("renders extra children above the Input block when expanded", async () => {
    const user = userEvent.setup();
    render(
      <CardShell
        icon={<span />}
        tool="regen"
        summary="done"
        pending={false}
        input={{}}
        result={null}
      >
        <p>Extra detail</p>
      </CardShell>,
    );
    await user.click(screen.getByRole("button", { expanded: false }));
    expect(screen.getByText("Extra detail")).toBeInTheDocument();
  });
});

describe("StatusPill", () => {
  it("renders with each tone variant", () => {
    const { rerender } = render(<StatusPill label="ok" tone="ok" />);
    expect(screen.getByText("ok")).toBeInTheDocument();
    rerender(<StatusPill label="warn" tone="warn" />);
    expect(screen.getByText("warn")).toBeInTheDocument();
    rerender(<StatusPill label="info" tone="info" />);
    expect(screen.getByText("info")).toBeInTheDocument();
  });
});
