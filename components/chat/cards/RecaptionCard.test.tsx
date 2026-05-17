/**
 * RecaptionCard surfaces the chosen caption style/preset.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { ToolCallView } from "@/lib/chat";

import { RecaptionCard } from "./RecaptionCard";

function makeCall(input: unknown): ToolCallView {
  return {
    id: "c1",
    tool: "recaption",
    input,
    result: null,
    pending: true,
  };
}

describe("RecaptionCard", () => {
  it("renders the style as a summary pill", () => {
    render(<RecaptionCard call={makeCall({ style: "bold_yellow" })} />);
    expect(screen.getAllByText(/bold_yellow/).length).toBeGreaterThan(0);
  });

  it("uses the preset key when style is missing", () => {
    render(<RecaptionCard call={makeCall({ preset: "punchy" })} />);
    expect(screen.getAllByText(/punchy/).length).toBeGreaterThan(0);
  });

  it("falls back when input is null", () => {
    render(<RecaptionCard call={makeCall(null)} />);
    expect(screen.getByText(/regenerating captions/)).toBeInTheDocument();
  });

  it("ignores non-string style values", () => {
    render(<RecaptionCard call={makeCall({ style: 42 })} />);
    expect(screen.queryByText("42")).not.toBeInTheDocument();
  });

  it("handles null input", () => {
    render(<RecaptionCard call={makeCall(null)} />);
    expect(screen.getByText(/regenerating captions/)).toBeInTheDocument();
  });
});
