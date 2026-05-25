/**
 * Tests for IntegrationsSection.
 *
 * Covers: empty state, rendering a masked config row, Add -> createIntegration
 * with parsed JSON config + active coercion, and Archive -> archiveIntegration.
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh, replace: vi.fn() }),
}));

const createIntegration = vi.fn<(...a: unknown[]) => unknown>(() => Promise.resolve({}));
const updateIntegration = vi.fn<(...a: unknown[]) => unknown>(() => Promise.resolve({}));
const archiveIntegration = vi.fn<(...a: unknown[]) => unknown>(() => Promise.resolve({}));
vi.mock("@/lib/clients/api", () => ({
  createIntegration: (...a: unknown[]) => createIntegration(...a),
  updateIntegration: (...a: unknown[]) => updateIntegration(...a),
  archiveIntegration: (...a: unknown[]) => archiveIntegration(...a),
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { IntegrationsSection } from "./IntegrationsSection";
import type { ClientIntegration } from "@/lib/clients/schemas";

const ROW = {
  id: "i1",
  client_id: "c1",
  provider: "meta",
  external_id: "act_123",
  config: { access_token: "********3456" },
  active: true,
  created_at: "2025-01-01T00:00:00Z",
  updated_at: "2025-01-01T00:00:00Z",
  deleted_at: null,
} as ClientIntegration;

afterEach(() => vi.clearAllMocks());

describe("IntegrationsSection", () => {
  it("shows the empty state", () => {
    render(<IntegrationsSection clientId="c1" integrations={[]} />);
    expect(screen.getByText(/no integrations yet/i)).toBeInTheDocument();
  });

  it("renders an integration with its masked config", () => {
    render(<IntegrationsSection clientId="c1" integrations={[ROW]} />);
    expect(screen.getByText("meta")).toBeInTheDocument();
    expect(screen.getByText("act_123")).toBeInTheDocument();
    // The masked secret is shown verbatim (already masked by the server).
    expect(screen.getByText(/\*{4}3456/)).toBeInTheDocument();
  });

  it("creates an integration with parsed JSON config + boolean active", async () => {
    render(<IntegrationsSection clientId="c1" integrations={[]} />);
    await userEvent.click(screen.getByRole("button", { name: /add/i }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText("External id"), "act_999");
    // user-event treats `{` as a key descriptor; `{{` types a literal brace.
    await userEvent.type(within(dialog).getByLabelText("Config (JSON)"), '{{"api_key":"x"}');
    await userEvent.click(within(dialog).getByRole("button", { name: /save/i }));
    await waitFor(() => expect(createIntegration).toHaveBeenCalled());
    const [clientId, body] = createIntegration.mock.calls[0]! as unknown as [
      string,
      Record<string, unknown>,
    ];
    expect(clientId).toBe("c1");
    expect(body).toMatchObject({
      provider: "meta",
      external_id: "act_999",
      config: { api_key: "x" },
      active: true,
    });
  });

  it("creates with empty external id + config (null/{} branches)", async () => {
    render(<IntegrationsSection clientId="c1" integrations={[]} />);
    await userEvent.click(screen.getByRole("button", { name: /add/i }));
    const dialog = await screen.findByRole("dialog");
    // Leave external_id + config blank; just submit.
    await userEvent.click(within(dialog).getByRole("button", { name: /save/i }));
    await waitFor(() => expect(createIntegration).toHaveBeenCalled());
    const body = createIntegration.mock.calls[0]![1] as unknown as Record<string, unknown>;
    expect(body).toEqual({ provider: "meta", external_id: null, config: {}, active: true });
  });

  it("rejects invalid JSON config", async () => {
    render(<IntegrationsSection clientId="c1" integrations={[]} />);
    await userEvent.click(screen.getByRole("button", { name: /add/i }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText("Config (JSON)"), "{{not json");
    await userEvent.click(within(dialog).getByRole("button", { name: /save/i }));
    await waitFor(() =>
      expect(within(dialog).getByText(/must be valid json/i)).toBeInTheDocument(),
    );
    expect(createIntegration).not.toHaveBeenCalled();
  });

  it("edits an integration and re-enters config", async () => {
    render(<IntegrationsSection clientId="c1" integrations={[ROW]} />);
    await userEvent.click(screen.getByRole("button", { name: /edit integration/i }));
    const dialog = await screen.findByRole("dialog");
    // External id is seeded from the row.
    expect(dialog.querySelector("#external_id")).toHaveValue("act_123");
    await userEvent.type(within(dialog).getByLabelText("Config (JSON)"), '{{"key":"v"}');
    await userEvent.click(within(dialog).getByRole("button", { name: /save/i }));
    await waitFor(() => expect(updateIntegration).toHaveBeenCalled());
    const [clientId, igId, body] = updateIntegration.mock.calls[0]! as unknown as [
      string,
      string,
      Record<string, unknown>,
    ];
    expect(clientId).toBe("c1");
    expect(igId).toBe("i1");
    expect(body).toMatchObject({ config: { key: "v" }, active: true });
  });

  it("renders an integration with no external id", () => {
    render(
      <IntegrationsSection
        clientId="c1"
        integrations={[{ ...ROW, id: "i2", external_id: null, active: false } as ClientIntegration]}
      />,
    );
    expect(screen.getByText("Inactive")).toBeInTheDocument();
  });

  it("archives an integration", async () => {
    render(<IntegrationsSection clientId="c1" integrations={[ROW]} />);
    await userEvent.click(screen.getByRole("button", { name: /archive integration/i }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Archive" }));
    await waitFor(() => expect(archiveIntegration).toHaveBeenCalledWith("c1", "i1"));
  });
});
