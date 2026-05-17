/**
 * RegenerateImageCard surfaces the prompt and ratio for an image regen
 * tool call. Tests cover summary derivation, the ratio pill, and the
 * expanded prompt block.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import type { ToolCallView } from "@/lib/chat";

import { RegenerateImageCard } from "./RegenerateImageCard";

function makeCall(over: Partial<ToolCallView> = {}): ToolCallView {
  return {
    id: "c1",
    tool: "regenerate_image",
    input: { prompt: "moody sunset", ratio: "1x1" },
    result: null,
    pending: true,
    ...over,
  };
}

describe("RegenerateImageCard", () => {
  it("renders prompt as summary and a ratio pill", () => {
    render(<RegenerateImageCard call={makeCall()} />);
    expect(screen.getAllByText(/moody sunset/).length).toBeGreaterThan(0);
    expect(screen.getByText("1x1")).toBeInTheDocument();
  });

  it("omits the ratio pill when input has no ratio", () => {
    render(<RegenerateImageCard call={makeCall({ input: { prompt: "go" } })} />);
    expect(screen.queryByText("1x1")).not.toBeInTheDocument();
  });

  it("ignores non-string ratios", () => {
    render(<RegenerateImageCard call={makeCall({ input: { prompt: "x", ratio: 7 } })} />);
    expect(screen.queryByText("7")).not.toBeInTheDocument();
  });

  it("falls back to 'regenerating…' when prompt missing", () => {
    render(<RegenerateImageCard call={makeCall({ input: null })} />);
    expect(screen.getByText(/regenerating…/)).toBeInTheDocument();
  });

  it("shows the prompt in the expanded detail body", async () => {
    const user = userEvent.setup();
    render(<RegenerateImageCard call={makeCall()} />);
    await user.click(screen.getByRole("button", { expanded: false }));
    expect(screen.getByText("Prompt")).toBeInTheDocument();
  });

  it("ignores null/undefined input for ratio reading", () => {
    render(<RegenerateImageCard call={makeCall({ input: null })} />);
    expect(screen.queryByText("1x1")).not.toBeInTheDocument();
  });
});
