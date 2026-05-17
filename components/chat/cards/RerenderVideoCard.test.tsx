/**
 * RerenderVideoCard is a near-static "action complete" tile — no input
 * fields to summarise. The interesting bit is the pending vs done copy.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { ToolCallView } from "@/lib/chat";

import { RerenderVideoCard } from "./RerenderVideoCard";

function makeCall(pending: boolean): ToolCallView {
  return {
    id: "c1",
    tool: "rerender_video",
    input: null,
    result: pending ? null : { ok: true },
    pending,
  };
}

describe("RerenderVideoCard", () => {
  it("shows the in-flight summary while pending", () => {
    render(<RerenderVideoCard call={makeCall(true)} />);
    expect(screen.getByText(/rerendering composed MP4/)).toBeInTheDocument();
  });

  it("shows the done summary when not pending", () => {
    render(<RerenderVideoCard call={makeCall(false)} />);
    expect(screen.getByText(/composite refreshed/)).toBeInTheDocument();
  });
});
