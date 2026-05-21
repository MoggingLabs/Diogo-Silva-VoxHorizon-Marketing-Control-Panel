/**
 * OperatorKickoffForm: a free-text brief + optional client picker + "Hire the
 * operator" button that calls `kickoffOperatorPipeline` and navigates to the
 * new pipeline. Tests cover the disabled gate, success navigation, in-flight
 * label, error handling, and the optional client selector.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ClientOption } from "@/lib/realtime/client-data";

// Radix Select uses ResizeObserver / pointer capture / scrollIntoView, none of
// which jsdom implements. Polyfill them so the picker can mount + open.
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}
if (!HTMLElement.prototype.hasPointerCapture) {
  HTMLElement.prototype.hasPointerCapture = () => false;
}
if (!HTMLElement.prototype.releasePointerCapture) {
  HTMLElement.prototype.releasePointerCapture = () => {};
}
if (!HTMLElement.prototype.scrollIntoView) {
  HTMLElement.prototype.scrollIntoView = () => {};
}

const routerPush = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPush, refresh: vi.fn(), replace: vi.fn() }),
}));

const kickoffOperatorPipeline = vi.fn();
vi.mock("@/lib/pipeline/client", () => ({
  kickoffOperatorPipeline: (...args: unknown[]) => kickoffOperatorPipeline(...args),
}));

// Clients are fetched on mount via the service-role `/api/clients` helper.
const fetchClients = vi.fn<() => Promise<ClientOption[]>>(async () => []);
vi.mock("@/lib/realtime/client-data", () => ({
  fetchClients: () => fetchClients(),
}));

import { OperatorKickoffForm } from "./OperatorKickoffForm";

beforeEach(() => {
  routerPush.mockReset();
  kickoffOperatorPipeline.mockReset();
  fetchClients.mockReset();
  fetchClients.mockResolvedValue([
    { id: "11111111-1111-4111-8111-111111111111", name: "Acme Roofing", slug: "acme", service_type: "roofing", status: "active" },
    { id: "22222222-2222-4222-8222-222222222222", name: "Beta Remodel", slug: "beta", service_type: "remodeling", status: "active" },
  ]);
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

  it("renders the optional client picker defaulting to 'No client / generic'", async () => {
    render(<OperatorKickoffForm />);
    expect(screen.getByLabelText("Client (optional)")).toBeInTheDocument();
    // The default selected value is shown in the trigger.
    expect(await screen.findByText(/No client \/ generic/)).toBeInTheDocument();
  });

  it("omits client_id from the kickoff body when no client is picked", async () => {
    kickoffOperatorPipeline.mockResolvedValue({ id: "p1" });
    const user = userEvent.setup();
    render(<OperatorKickoffForm />);
    await user.type(screen.getByTestId("operator-instruction"), "4 roofing ads");
    await user.click(screen.getByRole("button", { name: /hire the operator/i }));
    await waitFor(() => {
      expect(kickoffOperatorPipeline).toHaveBeenCalledWith({ instruction: "4 roofing ads" });
    });
    const arg = kickoffOperatorPipeline.mock.calls[0]![0] as Record<string, unknown>;
    expect("client_id" in arg).toBe(false);
  });

  it("includes the chosen client_id in the kickoff body when a client is picked", async () => {
    kickoffOperatorPipeline.mockResolvedValue({ id: "p2" });
    const user = userEvent.setup();
    render(<OperatorKickoffForm />);

    // Wait for the fetched clients to populate the picker.
    await screen.findByText(/No client \/ generic/);
    await user.click(screen.getByLabelText("Client (optional)"));
    await user.click(await screen.findByRole("option", { name: /Acme Roofing/ }));

    await user.type(screen.getByTestId("operator-instruction"), "4 roofing ads");
    await user.click(screen.getByRole("button", { name: /hire the operator/i }));

    await waitFor(() => {
      expect(kickoffOperatorPipeline).toHaveBeenCalledWith({
        instruction: "4 roofing ads",
        client_id: "11111111-1111-4111-8111-111111111111",
      });
    });
  });

  it("still kicks off generically when the client list fails to load", async () => {
    fetchClients.mockRejectedValue(new Error("clients down"));
    kickoffOperatorPipeline.mockResolvedValue({ id: "p3" });
    const user = userEvent.setup();
    render(<OperatorKickoffForm />);
    await user.type(screen.getByTestId("operator-instruction"), "4 roofing ads");
    await user.click(screen.getByRole("button", { name: /hire the operator/i }));
    await waitFor(() => {
      expect(kickoffOperatorPipeline).toHaveBeenCalledWith({ instruction: "4 roofing ads" });
    });
  });
});
