/**
 * SwapBrollCard summarises a `swap_broll` call: which script segment +
 * which replacement clip. Tests cover the four (segment, clip) combos
 * and the empty-input fallback.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { ToolCallView } from "@/lib/chat";

import { SwapBrollCard } from "./SwapBrollCard";

function makeCall(input: unknown): ToolCallView {
  return {
    id: "c1",
    tool: "swap_broll",
    input,
    result: null,
    pending: true,
  };
}

describe("SwapBrollCard", () => {
  it("shows segment + clip when both present", () => {
    render(<SwapBrollCard call={makeCall({ segment_idx: 1, clip_id: "abc" })} />);
    expect(screen.getByText(/swap segment 2 → abc/)).toBeInTheDocument();
    expect(screen.getByText(/seg 2/)).toBeInTheDocument();
    expect(screen.getByText("abc")).toBeInTheDocument();
  });

  it("shows segment-only summary when no clip", () => {
    render(<SwapBrollCard call={makeCall({ segment_idx: 0 })} />);
    expect(screen.getByText(/swap segment 1/)).toBeInTheDocument();
  });

  it("shows clip-only summary when no segment", () => {
    render(<SwapBrollCard call={makeCall({ clip_id: "xyz" })} />);
    expect(screen.getByText(/swap to xyz/)).toBeInTheDocument();
  });

  it("falls back to generic working text when neither is present", () => {
    render(<SwapBrollCard call={makeCall({})} />);
    expect(screen.getByText(/swapping b-roll/)).toBeInTheDocument();
  });

  it("rejects NaN segment_idx and treats it as missing", () => {
    render(<SwapBrollCard call={makeCall({ segment_idx: Number.NaN, clip_id: "x" })} />);
    expect(screen.getByText(/swap to x/)).toBeInTheDocument();
  });

  it("rejects non-number segment_idx and non-string clip_id", () => {
    render(<SwapBrollCard call={makeCall({ segment_idx: "1", clip_id: 5 })} />);
    expect(screen.getByText(/swapping b-roll/)).toBeInTheDocument();
  });

  it("returns nulls for non-object input", () => {
    render(<SwapBrollCard call={makeCall(null)} />);
    expect(screen.getByText(/swapping b-roll/)).toBeInTheDocument();
  });
});
