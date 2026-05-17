/**
 * RegenerateVoiceoverCard surfaces voice id + script preview for a
 * voiceover regen.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import type { ToolCallView } from "@/lib/chat";

import { RegenerateVoiceoverCard } from "./RegenerateVoiceoverCard";

function makeCall(over: Partial<ToolCallView> = {}): ToolCallView {
  return {
    id: "c1",
    tool: "regenerate_voiceover",
    input: { voice_id: "v1", script: "hello world" },
    result: null,
    pending: true,
    ...over,
  };
}

describe("RegenerateVoiceoverCard", () => {
  it("shows the voice_id pill and a script-derived summary", () => {
    render(<RegenerateVoiceoverCard call={makeCall()} />);
    expect(screen.getByText(/voice: v1/)).toBeInTheDocument();
    expect(screen.getAllByText(/hello world/).length).toBeGreaterThan(0);
  });

  it("falls back when neither voice_id nor script is provided", () => {
    render(<RegenerateVoiceoverCard call={makeCall({ input: null })} />);
    expect(screen.getByText(/regenerating voiceover/)).toBeInTheDocument();
  });

  it("renders voice_id mono line in expanded detail", async () => {
    const user = userEvent.setup();
    render(<RegenerateVoiceoverCard call={makeCall()} />);
    await user.click(screen.getByRole("button", { expanded: false }));
    expect(screen.getByText(/voice_id = v1/)).toBeInTheDocument();
  });

  it("omits the voice pill when voice_id is missing or empty", () => {
    render(<RegenerateVoiceoverCard call={makeCall({ input: { script: "hi", voice_id: "" } })} />);
    expect(screen.queryByText(/voice: /)).not.toBeInTheDocument();
  });

  it("ignores non-string voice_id values", () => {
    render(<RegenerateVoiceoverCard call={makeCall({ input: { script: "hi", voice_id: 99 } })} />);
    expect(screen.queryByText(/voice: 99/)).not.toBeInTheDocument();
  });

  it("handles null input", () => {
    render(<RegenerateVoiceoverCard call={makeCall({ input: null })} />);
    expect(screen.queryByText(/voice: /)).not.toBeInTheDocument();
  });
});
