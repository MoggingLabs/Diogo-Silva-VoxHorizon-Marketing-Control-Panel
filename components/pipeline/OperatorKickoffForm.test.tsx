/**
 * OperatorKickoffForm: a free-text brief + "Hire the operator" button that
 * calls `kickoffOperatorPipeline` and navigates to the new pipeline. Tests
 * cover the disabled gate, success navigation, in-flight label, and error.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const routerPush = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPush, refresh: vi.fn(), replace: vi.fn() }),
}));

const kickoffOperatorPipeline = vi.fn();
vi.mock("@/lib/pipeline/client", () => ({
  kickoffOperatorPipeline: (...args: unknown[]) => kickoffOperatorPipeline(...args),
}));

import { OperatorKickoffForm } from "./OperatorKickoffForm";

beforeEach(() => {
  routerPush.mockReset();
  kickoffOperatorPipeline.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("OperatorKickoffForm", () => {
  it("disables the submit button until a non-empty brief is typed", async () => {
    const user = userEvent.setup();
    render(<OperatorKickoffForm />);
    const button = screen.getByRole("button", { name: /hire the operator/i });
    expect(button).toBeDisabled();
    await user.type(screen.getByTestId("operator-instruction"), "4 roofing ads");
    expect(button).toBeEnabled();
  });

  it("kicks off the operator and navigates to the new pipeline", async () => {
    kickoffOperatorPipeline.mockResolvedValue({ id: "p123" });
    const user = userEvent.setup();
    render(<OperatorKickoffForm />);
    await user.type(screen.getByTestId("operator-instruction"), "4 roofing ads, Austin");
    await user.click(screen.getByRole("button", { name: /hire the operator/i }));
    await waitFor(() => {
      expect(kickoffOperatorPipeline).toHaveBeenCalledWith({
        instruction: "4 roofing ads, Austin",
      });
      expect(routerPush).toHaveBeenCalledWith("/pipeline/p123");
    });
  });

  it("submits on Cmd/Ctrl+Enter", async () => {
    kickoffOperatorPipeline.mockResolvedValue({ id: "p9" });
    const user = userEvent.setup();
    render(<OperatorKickoffForm />);
    const textarea = screen.getByTestId("operator-instruction");
    await user.type(textarea, "two remodeling ads");
    await user.type(textarea, "{Control>}{Enter}{/Control}");
    await waitFor(() => expect(kickoffOperatorPipeline).toHaveBeenCalled());
  });

  it("surfaces an inline error and re-enables the button on failure", async () => {
    kickoffOperatorPipeline.mockRejectedValue(new Error("worker offline"));
    const user = userEvent.setup();
    render(<OperatorKickoffForm />);
    await user.type(screen.getByTestId("operator-instruction"), "x");
    await user.click(screen.getByRole("button", { name: /hire the operator/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent("worker offline");
    expect(screen.getByRole("button", { name: /hire the operator/i })).toBeEnabled();
    expect(routerPush).not.toHaveBeenCalled();
  });

  it("shows the Starting… label while the request is in flight", async () => {
    let resolve: (v: unknown) => void = () => {};
    kickoffOperatorPipeline.mockImplementationOnce(() => new Promise((r) => (resolve = r)));
    const user = userEvent.setup();
    render(<OperatorKickoffForm />);
    await user.type(screen.getByTestId("operator-instruction"), "x");
    await user.click(screen.getByRole("button", { name: /hire the operator/i }));
    expect(await screen.findByText(/Starting…/)).toBeInTheDocument();
    resolve({ id: "p1" });
  });
});
