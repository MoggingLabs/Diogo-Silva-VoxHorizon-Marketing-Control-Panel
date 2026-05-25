/**
 * Tests for the command-palette stub: it lists nav commands and navigates on
 * select.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

import { CommandPalette } from "./CommandPalette";

afterEach(() => {
  vi.clearAllMocks();
});

describe("CommandPalette", () => {
  it("does not render its content when closed", () => {
    render(<CommandPalette open={false} onOpenChange={vi.fn()} />);
    expect(screen.queryByText("Dashboard")).not.toBeInTheDocument();
  });

  it("lists navigation commands when open", () => {
    render(<CommandPalette open onOpenChange={vi.fn()} />);
    expect(screen.getByText("Dashboard")).toBeInTheDocument();
    expect(screen.getByText("Operator Console")).toBeInTheDocument();
    expect(screen.getByText("Clients")).toBeInTheDocument();
  });

  it("navigates and closes on select", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(<CommandPalette open onOpenChange={onOpenChange} />);
    await user.click(screen.getByText("Clients"));
    expect(push).toHaveBeenCalledWith("/clients");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
