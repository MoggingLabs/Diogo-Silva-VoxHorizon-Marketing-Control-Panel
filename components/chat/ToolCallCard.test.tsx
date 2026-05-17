/**
 * `ToolCallCard` dispatches on `call.tool` to a renderer in CARD_RENDERERS
 * and wraps the result in an error boundary.
 *
 * Tests cover the dispatch table (each registered tool name), the fallback
 * path for unknown tools, and the error-boundary's recovery story when the
 * inner renderer throws.
 */
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ToolCallView } from "@/lib/chat";

// Mock one of the registered card renderers to throw so the error
// boundary inside ToolCallCard fires. We pick `recaption` because its
// shape is the smallest of the dedicated cards.
vi.mock("./cards/RecaptionCard", () => ({
  RecaptionCard: ({ call }: { call: ToolCallView }) => {
    if (call.tool === "recaption" && (call.input as { boom?: unknown })?.boom) {
      throw new Error("render boom");
    }
    return <div data-testid="real-recaption">{call.tool}</div>;
  },
}));

import { ToolCallCard } from "./ToolCallCard";

function makeCall(tool: string, over: Partial<ToolCallView> = {}): ToolCallView {
  return {
    id: "c1",
    tool,
    input: { prompt: "hi" },
    result: null,
    pending: true,
    ...over,
  };
}

describe("ToolCallCard dispatch", () => {
  it.each([
    ["regenerate_image"],
    ["composite_image"],
    ["regenerate_voiceover"],
    ["swap_broll"],
    ["rerender_video"],
  ])("renders the registered renderer for %s", (tool) => {
    render(<ToolCallCard call={makeCall(tool)} />);
    expect(screen.getByText(tool)).toBeInTheDocument();
  });

  it("renders the mocked recaption stand-in for the happy path", () => {
    render(<ToolCallCard call={makeCall("recaption")} />);
    expect(screen.getByTestId("real-recaption")).toBeInTheDocument();
  });

  it("falls back to FallbackCard for unknown tools", () => {
    render(<ToolCallCard call={makeCall("never_heard_of_it")} />);
    expect(screen.getByText("never_heard_of_it")).toBeInTheDocument();
  });
});

describe("ToolCallCard error boundary", () => {
  let originalError: typeof console.error;

  beforeEach(() => {
    originalError = console.error;
    // React logs caught errors to console.error; silence to keep test
    // output readable.
    console.error = vi.fn();
  });

  afterEach(() => {
    console.error = originalError;
  });

  it("renders the malformed-payload tile when the inner renderer throws", () => {
    render(<ToolCallCard call={makeCall("recaption", { input: { boom: true } })} />);
    expect(screen.getByText(/failed to render/)).toBeInTheDocument();
    // The tool name still appears so the operator knows which call broke.
    expect(screen.getByText("recaption")).toBeInTheDocument();
    expect(console.error).toHaveBeenCalled();
  });
});
