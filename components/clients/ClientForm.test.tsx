/**
 * Tests for ClientForm (create-client form).
 *
 * Covers: slug auto-suggestion from the name, client-side zod validation
 * blocking a bad slug, and the happy path POST -> route to the new client.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh: vi.fn(), replace: vi.fn() }),
}));

const createClient = vi.fn<(...a: unknown[]) => unknown>(() =>
  Promise.resolve({ client: { id: "new-id" } }),
);
vi.mock("@/lib/clients/api", () => ({
  createClient: (...a: unknown[]) => createClient(...a),
}));

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock("sonner", () => ({
  toast: { success: (m: string) => toastSuccess(m), error: (m: string) => toastError(m) },
}));

import { ClientForm } from "./ClientForm";

afterEach(() => vi.clearAllMocks());

describe("ClientForm", () => {
  it("auto-suggests a slug from the name until edited", async () => {
    render(<ClientForm />);
    await userEvent.type(screen.getByLabelText("Name"), "Acme Roofing Co");
    await waitFor(() => expect(screen.getByLabelText("Slug")).toHaveValue("acme-roofing-co"));
  });

  it("creates a client and routes to its detail page", async () => {
    render(<ClientForm />);
    await userEvent.type(screen.getByLabelText("Name"), "Acme Roofing");
    await userEvent.click(screen.getByRole("button", { name: /create client/i }));
    await waitFor(() => expect(createClient).toHaveBeenCalled());
    const body = createClient.mock.calls[0]![0] as unknown as Record<string, unknown>;
    expect(body).toMatchObject({
      name: "Acme Roofing",
      slug: "acme-roofing",
      service_type: "roofing",
    });
    await waitFor(() => expect(push).toHaveBeenCalledWith("/clients/new-id"));
  });

  it("includes optional integration fields when filled", async () => {
    render(<ClientForm />);
    await userEvent.type(screen.getByLabelText("Name"), "Acme");
    await userEvent.type(screen.getByLabelText(/cpl target/i), "75");
    await userEvent.type(screen.getByLabelText(/meta ad account id/i), "act_5");
    await userEvent.type(screen.getByLabelText(/ghl location id/i), "loc_1");
    await userEvent.type(screen.getByLabelText(/drive root folder id/i), "fold_1");
    await userEvent.click(screen.getByRole("button", { name: /create client/i }));
    await waitFor(() => expect(createClient).toHaveBeenCalled());
    const body = createClient.mock.calls[0]![0] as unknown as Record<string, unknown>;
    expect(body).toMatchObject({
      cpl_target: 75,
      meta_account_id: "act_5",
      ghl_location_id: "loc_1",
      drive_root_folder_id: "fold_1",
    });
  });

  it("toasts an error when the create request fails", async () => {
    createClient.mockRejectedValueOnce(new Error("slug taken"));
    render(<ClientForm />);
    await userEvent.type(screen.getByLabelText("Name"), "Acme");
    await userEvent.click(screen.getByRole("button", { name: /create client/i }));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("slug taken"));
  });

  it("blocks submit and shows an error when the slug is invalid", async () => {
    render(<ClientForm />);
    await userEvent.type(screen.getByLabelText("Name"), "X");
    // Override the auto-suggested slug with an invalid one.
    const slug = screen.getByLabelText("Slug");
    await userEvent.clear(slug);
    await userEvent.type(slug, "Bad Slug!");
    await userEvent.click(screen.getByRole("button", { name: /create client/i }));
    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(createClient).not.toHaveBeenCalled();
  });
});
