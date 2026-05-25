/**
 * Tests for ClientDetail (tabbed client detail view).
 *
 * Covers: header + tabs render, edit-client dialog -> updateClient, archive ->
 * archiveClient, the archived-state restore path, and switching to a child tab
 * shows that section.
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh, replace: vi.fn() }),
}));

const updateClient = vi.fn<(...a: unknown[]) => unknown>(() => Promise.resolve({}));
const archiveClient = vi.fn<(...a: unknown[]) => unknown>(() => Promise.resolve({}));
const restoreClient = vi.fn<(...a: unknown[]) => unknown>(() => Promise.resolve({}));
vi.mock("@/lib/clients/api", () => ({
  updateClient: (...a: unknown[]) => updateClient(...a),
  archiveClient: (...a: unknown[]) => archiveClient(...a),
  restoreClient: (...a: unknown[]) => restoreClient(...a),
  // child + integration + profile wrappers are exercised by their own tests;
  // stub them so the section components mount without a real fetch.
  createChild: vi.fn(() => Promise.resolve({ item: { id: "x" } })),
  updateChild: vi.fn(() => Promise.resolve({})),
  archiveChild: vi.fn(() => Promise.resolve({})),
  createIntegration: vi.fn(() => Promise.resolve({})),
  updateIntegration: vi.fn(() => Promise.resolve({})),
  archiveIntegration: vi.fn(() => Promise.resolve({})),
  saveProfile: vi.fn(() => Promise.resolve({})),
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { ClientDetail } from "./ClientDetail";
import type { Client } from "@/lib/clients/schemas";

const CLIENT = {
  id: "c1",
  name: "Acme Roofing",
  slug: "acme",
  service_type: "roofing",
  status: "active",
  created_at: "2025-01-01T00:00:00Z",
  deleted_at: null,
} as Client;

function baseProps(overrides: Partial<Parameters<typeof ClientDetail>[0]> = {}) {
  return {
    client: CLIENT,
    profile: null,
    services: [],
    valueProps: [],
    offers: [],
    constraints: [],
    assets: [],
    pastProjects: [],
    integrations: [],
    activity: [
      { id: "e1", kind: "client_created", payload: null, created_at: "2025-01-01T00:00:00Z" },
    ],
    ...overrides,
  };
}

afterEach(() => vi.clearAllMocks());

describe("ClientDetail", () => {
  it("renders the header, slug, and tabs", () => {
    render(<ClientDetail {...baseProps()} />);
    expect(screen.getByRole("heading", { name: "Acme Roofing" })).toBeInTheDocument();
    expect(screen.getByText(/acme · roofing/i)).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /profile/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /integrations/i })).toBeInTheDocument();
  });

  it("edits client identity via the edit dialog", async () => {
    render(<ClientDetail {...baseProps()} />);
    await userEvent.click(screen.getByRole("button", { name: /^edit$/i }));
    const dialog = await screen.findByRole("dialog");
    const name = within(dialog).getByLabelText("Name");
    await userEvent.clear(name);
    await userEvent.type(name, "Acme Roofing LLC");
    await userEvent.click(within(dialog).getByRole("button", { name: /save/i }));
    await waitFor(() => expect(updateClient).toHaveBeenCalled());
    const [id, body] = updateClient.mock.calls[0]! as unknown as [string, Record<string, unknown>];
    expect(id).toBe("c1");
    expect(body).toMatchObject({ name: "Acme Roofing LLC", slug: "acme" });
  });

  it("archives the client", async () => {
    render(<ClientDetail {...baseProps()} />);
    await userEvent.click(screen.getByRole("button", { name: /^archive$/i }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Archive" }));
    await waitFor(() => expect(archiveClient).toHaveBeenCalledWith("c1"));
  });

  it("shows Restore for an archived client and calls restoreClient", async () => {
    render(
      <ClientDetail
        {...baseProps({ client: { ...CLIENT, deleted_at: "2025-02-01T00:00:00Z" } as Client })}
      />,
    );
    expect(screen.getByText("Archived")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /restore/i }));
    await waitFor(() => expect(restoreClient).toHaveBeenCalledWith("c1"));
  });

  it("switches to the Activity tab and lists events", async () => {
    render(<ClientDetail {...baseProps()} />);
    await userEvent.click(screen.getByRole("tab", { name: /activity/i }));
    expect(await screen.findByText("client_created")).toBeInTheDocument();
  });

  it("renders each child tab section with its rows", async () => {
    render(
      <ClientDetail
        {...baseProps({
          services: [
            {
              id: "s1",
              client_id: "c1",
              service_name: "Roofing",
              sort_order: 0,
              created_at: "",
              deleted_at: null,
            },
          ],
          valueProps: [
            {
              id: "vp1",
              client_id: "c1",
              kind: "usp",
              prop_text: "Fast",
              sort_order: 0,
              created_at: "",
              deleted_at: null,
            },
            {
              id: "vp2",
              client_id: "c1",
              kind: "differentiator",
              prop_text: "Family owned",
              sort_order: 1,
              created_at: "",
              deleted_at: null,
            },
          ],
          offers: [
            {
              id: "o1",
              client_id: "c1",
              offer_text: "Free quote",
              active: true,
              sort_order: 0,
              created_at: "",
              deleted_at: null,
            },
            {
              id: "o2",
              client_id: "c1",
              offer_text: "Old promo",
              active: false,
              sort_order: 1,
              created_at: "",
              deleted_at: null,
            },
          ],
          constraints: [
            {
              id: "cc1",
              client_id: "c1",
              constraint_text: "No guarantees",
              sort_order: 0,
              created_at: "",
              deleted_at: null,
            },
          ],
          assets: [
            {
              id: "a1",
              client_id: "c1",
              kind: "logo",
              source: "drive",
              ref: "drive-id",
              label: "Main logo",
              formats: null,
              sort_order: 0,
              created_at: "",
              deleted_at: null,
            },
            {
              id: "a2",
              client_id: "c1",
              kind: "review",
              source: "url",
              ref: "https://r.example/1",
              label: null,
              formats: null,
              sort_order: 1,
              created_at: "",
              deleted_at: null,
            },
          ],
          pastProjects: [
            {
              id: "p1",
              client_id: "c1",
              url: "https://example.com/p",
              sort_order: 0,
              created_at: "",
              deleted_at: null,
            },
          ],
        })}
      />,
    );

    await userEvent.click(screen.getByRole("tab", { name: /services/i }));
    expect(await screen.findByText("Roofing")).toBeInTheDocument();
    expect(screen.getByText("Fast")).toBeInTheDocument();

    expect(screen.getByText("Family owned")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("tab", { name: /offers/i }));
    expect(await screen.findByText("Free quote")).toBeInTheDocument();
    expect(screen.getByText("Old promo")).toBeInTheDocument();
    expect(screen.getByText("No guarantees")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("tab", { name: /assets/i }));
    expect(await screen.findByText("Main logo")).toBeInTheDocument();
    // Asset with no label falls back to its ref.
    expect(screen.getByText("https://r.example/1")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("tab", { name: /past projects/i }));
    expect(await screen.findByRole("link", { name: "https://example.com/p" })).toBeInTheDocument();
  });

  it("opens a child edit dialog seeded from the row (offers toValues/toBody)", async () => {
    const { updateChild } = (await import("@/lib/clients/api")) as unknown as {
      updateChild: ReturnType<typeof vi.fn>;
    };
    render(
      <ClientDetail
        {...baseProps({
          offers: [
            {
              id: "o1",
              client_id: "c1",
              offer_text: "Free quote",
              active: false,
              sort_order: 0,
              created_at: "",
              deleted_at: null,
            },
          ],
        })}
      />,
    );
    await userEvent.click(screen.getByRole("tab", { name: /offers/i }));
    await userEvent.click(await screen.findByRole("button", { name: /edit offer/i }));
    const dialog = await screen.findByRole("dialog");
    // Seeded from the row: offer_text present, active select reflects "false".
    expect(within(dialog).getByLabelText("Offer")).toHaveValue("Free quote");
    await userEvent.click(within(dialog).getByRole("button", { name: /save/i }));
    await waitFor(() => expect(updateChild).toHaveBeenCalled());
    const body = updateChild.mock.calls[0]![3] as Record<string, unknown>;
    // toBody coerces the string select back to a boolean.
    expect(body).toEqual({ offer_text: "Free quote", active: false });
  });

  it("opens an asset edit dialog (assets toValues/toBody with null label)", async () => {
    const { updateChild } = (await import("@/lib/clients/api")) as unknown as {
      updateChild: ReturnType<typeof vi.fn>;
    };
    render(
      <ClientDetail
        {...baseProps({
          assets: [
            {
              id: "a1",
              client_id: "c1",
              kind: "review",
              source: "url",
              ref: "https://r/1",
              label: null,
              formats: null,
              sort_order: 0,
              created_at: "",
              deleted_at: null,
            },
          ],
        })}
      />,
    );
    await userEvent.click(screen.getByRole("tab", { name: /assets/i }));
    await userEvent.click(await screen.findByRole("button", { name: /edit asset/i }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: /save/i }));
    await waitFor(() => expect(updateChild).toHaveBeenCalled());
    const body = updateChild.mock.calls[0]![3] as Record<string, unknown>;
    // Empty label/formats coerce back to null.
    expect(body).toMatchObject({ ref: "https://r/1", label: null, formats: null });
  });
});
