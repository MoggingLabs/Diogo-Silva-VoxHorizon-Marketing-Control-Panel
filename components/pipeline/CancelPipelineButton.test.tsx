/**
 * CancelPipelineButton renders a small destructive CTA + confirmation
 * dialog. The dialog uses Radix; we exercise the open/close/submit happy
 * paths plus the error path.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const routerRefresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: routerRefresh, push: vi.fn(), replace: vi.fn() }),
}));

const cancelPipeline = vi.fn();
vi.mock("@/lib/pipeline/client", () => ({
  cancelPipeline: (...args: unknown[]) => cancelPipeline(...args),
}));

import { CancelPipelineButton } from "./CancelPipelineButton";

beforeEach(() => {
  routerRefresh.mockReset();
  cancelPipeline.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("CancelPipelineButton", () => {
  it("opens the confirmation dialog on click", async () => {
    const user = userEvent.setup();
    render(<CancelPipelineButton pipelineId="p1" />);
    await user.click(screen.getByRole("button", { name: /Cancel pipeline/i }));
    expect(await screen.findByText(/Cancel this pipeline\?/)).toBeInTheDocument();
  });

  it("closes the dialog when 'Keep running' is clicked", async () => {
    const user = userEvent.setup();
    render(<CancelPipelineButton pipelineId="p1" />);
    await user.click(screen.getByRole("button", { name: /Cancel pipeline/i }));
    await user.click(await screen.findByRole("button", { name: /Keep running/i }));
    await waitFor(() => {
      expect(screen.queryByText(/Cancel this pipeline\?/)).not.toBeInTheDocument();
    });
  });

  it("calls cancelPipeline + router.refresh on confirm", async () => {
    cancelPipeline.mockResolvedValue({ pipeline: { id: "p1", status: "cancelled" } });
    const user = userEvent.setup();
    render(<CancelPipelineButton pipelineId="p1" />);
    await user.click(screen.getByRole("button", { name: /Cancel pipeline/i }));
    // The destructive Cancel button inside the dialog.
    const dialogButtons = await screen.findAllByRole("button", { name: /Cancel pipeline/i });
    // The trigger is the first; the dialog button is the second.
    await user.click(dialogButtons[dialogButtons.length - 1]!);
    await waitFor(() => {
      expect(cancelPipeline).toHaveBeenCalledWith("p1");
      expect(routerRefresh).toHaveBeenCalled();
    });
  });

  it("surfaces an inline error when cancelPipeline throws", async () => {
    cancelPipeline.mockRejectedValue(new Error("forbidden"));
    const user = userEvent.setup();
    render(<CancelPipelineButton pipelineId="p1" />);
    await user.click(screen.getByRole("button", { name: /Cancel pipeline/i }));
    const dialogButtons = await screen.findAllByRole("button", { name: /Cancel pipeline/i });
    await user.click(dialogButtons[dialogButtons.length - 1]!);
    expect(await screen.findByRole("alert")).toHaveTextContent("forbidden");
  });

  it("surfaces a non-Error rejection by stringifying it", async () => {
    cancelPipeline.mockRejectedValue("string oops");
    const user = userEvent.setup();
    render(<CancelPipelineButton pipelineId="p1" />);
    await user.click(screen.getByRole("button", { name: /Cancel pipeline/i }));
    const dialogButtons = await screen.findAllByRole("button", { name: /Cancel pipeline/i });
    await user.click(dialogButtons[dialogButtons.length - 1]!);
    expect(await screen.findByRole("alert")).toHaveTextContent("string oops");
  });

  it("shows the Cancelling… label while the request is in flight", async () => {
    let resolve: (v: unknown) => void = () => {};
    cancelPipeline.mockImplementationOnce(() => new Promise((r) => (resolve = r)));
    const user = userEvent.setup();
    render(<CancelPipelineButton pipelineId="p1" />);
    await user.click(screen.getByRole("button", { name: /Cancel pipeline/i }));
    const dialogButtons = await screen.findAllByRole("button", { name: /Cancel pipeline/i });
    await user.click(dialogButtons[dialogButtons.length - 1]!);
    expect(await screen.findByText(/Cancelling…/)).toBeInTheDocument();
    resolve({ pipeline: { id: "p1" } });
  });
});
