/**
 * FallbackCard is the catch-all for unknown tool names. It just picks a
 * sensible summary string via `pickStringField` and hands the payload
 * to `CardShell`. Tests cover the summary picker + the no-input case.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { ToolCallView } from "@/lib/chat";

import { FallbackCard } from "./FallbackCard";

function makeCall(over: Partial<ToolCallView> = {}): ToolCallView {
  return {
    id: "c1",
    tool: "mystery_tool",
    input: { prompt: "draw a sunset" },
    result: null,
    pending: true,
    ...over,
  };
}

describe("FallbackCard", () => {
  it("renders the tool name and a summary derived from the prompt field", () => {
    render(<FallbackCard call={makeCall()} />);
    expect(screen.getByText("mystery_tool")).toBeInTheDocument();
    expect(screen.getByText(/draw a sunset/)).toBeInTheDocument();
  });

  it("falls back to a generic summary when input is empty", () => {
    render(<FallbackCard call={makeCall({ input: null })} />);
    expect(screen.getByText(/no input yet/)).toBeInTheDocument();
  });

  it("renders a non-pending check icon when not pending", () => {
    const { container } = render(<FallbackCard call={makeCall({ pending: false })} />);
    // Loader2 doesn't render when not pending — assert via class presence.
    expect(container.querySelector(".animate-spin")).toBeNull();
  });
});
