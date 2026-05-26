/**
 * Tests for ClientsTable (the Clients list view).
 *
 * Covers: rendering rows with name/slug/service/status, the archived badge,
 * the New-client action, opening the archive confirm + calling the API, and the
 * restore row-action path.
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const push = vi.fn();
const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh, replace: vi.fn() }),
  usePathname: () => "/clients",
  useSearchParams: () => new URLSearchParams(),
}));

const archiveClient = vi.fn<(...a: unknown[]) => unknown>(() => Promise.resolve({}));
const restoreClient = vi.fn<(...a: unknown[]) => unknown>(() => Promise.resolve({}));
vi.mock("@/lib/clients/api", () => ({
  archiveClient: (...a: unknown[]) => archiveClient(...a),
  restoreClient: (...a: unknown[]) => restoreClient(...a),
}));

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock("sonner", () => ({
  toast: { success: (m: string) => toastSuccess(m), error: (m: string) => toastError(m) },
}));

import { ClientsTable } from "./ClientsTable";

type Row = Parameters<typeof ClientsTable>[0]["initialClients"][number];

const ROWS: Row[] = [
  {
    id: "c1",
    name: "Acme Roofing",
    slug: "acme",
    service_type: "roofing",
    status: "active",
    created_at: "2025-01-01T00:00:00Z",
    deleted_at: null,
  },
  {
    id: "c2",
    name: "Old Co",
    slug: "old-co",
    service_type: "remodeling",
    status: "active",
    created_at: "2024-06-01T00:00:00Z",
    deleted_at: "2025-02-01T00:00:00Z",
  },
];

afterEach(() => vi.clearAllMocks());

describe("ClientsTable", () => {
  it("renders client rows with name, slug, and a status badge", () => {
    render(<ClientsTable initialClients={ROWS} loadError={null} />);
    expect(screen.getByRole("link", { name: "Acme Roofing" })).toBeInTheDocument();
    expect(screen.getByText("acme")).toBeInTheDocument();
    // Archived row reads "Archived" regardless of stored status.
    expect(screen.getByText("Archived")).toBeInTheDocument();
  });

  it("surfaces a load error", () => {
    render(<ClientsTable initialClients={[]} loadError="db down" />);
    expect(screen.getByText(/failed to load clients: db down/i)).toBeInTheDocument();
  });

  it("routes to the new-client page from the New button", async () => {
    render(<ClientsTable initialClients={ROWS} loadError={null} />);
    await userEvent.click(screen.getByRole("button", { name: /new client/i }));
    expect(push).toHaveBeenCalledWith("/clients/new");
  });

  it("archives a client through the confirm dialog", async () => {
    render(<ClientsTable initialClients={ROWS} loadError={null} />);
    // Open the row action menu for the active client (first row).
    const menus = screen.getAllByRole("button", { name: /row actions/i });
    await userEvent.click(menus[0]!);
    await userEvent.click(await screen.findByRole("menuitem", { name: /archive/i }));
    // Confirm dialog -> Archive.
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Archive" }));
    await waitFor(() => expect(archiveClient).toHaveBeenCalledWith("c1"));
    expect(refresh).toHaveBeenCalled();
  });

  it("restores an archived client from the row action", async () => {
    render(<ClientsTable initialClients={ROWS} loadError={null} />);
    const menus = screen.getAllByRole("button", { name: /row actions/i });
    // Second row is the archived client.
    await userEvent.click(menus[1]!);
    await userEvent.click(await screen.findByRole("menuitem", { name: /restore/i }));
    await waitFor(() => expect(restoreClient).toHaveBeenCalledWith("c2"));
    expect(toastSuccess).toHaveBeenCalled();
  });

  it("toasts an error when restore fails", async () => {
    restoreClient.mockRejectedValueOnce(new Error("nope"));
    render(<ClientsTable initialClients={ROWS} loadError={null} />);
    const menus = screen.getAllByRole("button", { name: /row actions/i });
    await userEvent.click(menus[1]!);
    await userEvent.click(await screen.findByRole("menuitem", { name: /restore/i }));
    await waitFor(() => expect(toastError).toHaveBeenCalled());
  });

  it("bulk-archives the selected clients", async () => {
    render(<ClientsTable initialClients={ROWS} loadError={null} />);
    // Select the active row's checkbox (skip the header select-all checkbox).
    const checkboxes = screen.getAllByRole("checkbox");
    await userEvent.click(checkboxes[1]!);
    // Bulk bar appears with the archive action.
    await userEvent.click(screen.getByRole("button", { name: /archive selected/i }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Archive" }));
    await waitFor(() => expect(archiveClient).toHaveBeenCalledWith("c1"));
    expect(refresh).toHaveBeenCalled();
  });

  it("reports a partial bulk-archive failure", async () => {
    archiveClient.mockRejectedValueOnce(new Error("nope"));
    render(<ClientsTable initialClients={ROWS} loadError={null} />);
    const checkboxes = screen.getAllByRole("checkbox");
    await userEvent.click(checkboxes[1]!);
    await userEvent.click(screen.getByRole("button", { name: /archive selected/i }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Archive" }));
    // The ConfirmArchive toasts the thrown error and keeps the dialog open.
    await waitFor(() => expect(toastError).toHaveBeenCalled());
  });

  it("routes to detail from the row Edit action", async () => {
    render(<ClientsTable initialClients={ROWS} loadError={null} />);
    const menus = screen.getAllByRole("button", { name: /row actions/i });
    await userEvent.click(menus[0]!);
    await userEvent.click(await screen.findByRole("menuitem", { name: /edit/i }));
    expect(push).toHaveBeenCalledWith("/clients/c1");
  });
});
