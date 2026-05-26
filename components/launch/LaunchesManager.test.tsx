/**
 * LaunchesManager (E5.1 / #595): unified image/video launches list with format
 * tab, archive/restore, and bulk archive.
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const routerRefresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: routerRefresh, push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/launches",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const archiveLaunch = vi.fn(async () => undefined);
const restoreLaunch = vi.fn(async () => undefined);
const listLaunches = vi.fn<(...a: unknown[]) => Promise<LaunchListRow[]>>(async () => []);
vi.mock("@/lib/launches/client", () => ({
  archiveLaunch: (...a: unknown[]) => archiveLaunch(...(a as [])),
  restoreLaunch: (...a: unknown[]) => restoreLaunch(...(a as [])),
  listLaunches: (...a: unknown[]) => listLaunches(...(a as [])),
}));

import { LaunchesManager } from "./LaunchesManager";
import type { LaunchListRow } from "@/lib/launches/client";

function row(overrides: Partial<LaunchListRow> = {}): LaunchListRow {
  return {
    id: "l1",
    brief_id: "b1",
    status: "posted",
    created_at: "2026-05-26T00:00:00Z",
    decided_at: null,
    decided_notes: null,
    payload: { brief_id_human: "br-1", client: { name: "Acme" } },
    deleted_at: null,
    ...overrides,
  };
}

beforeEach(() => {
  routerRefresh.mockReset();
  archiveLaunch.mockClear();
  restoreLaunch.mockClear();
  listLaunches.mockReset();
  listLaunches.mockResolvedValue([]);
});
afterEach(() => vi.restoreAllMocks());

describe("LaunchesManager", () => {
  it("renders the seeded image launches with brief + client + status", () => {
    render(<LaunchesManager initialImage={[row()]} initialVideo={[]} />);
    expect(screen.getByRole("link", { name: "br-1" })).toHaveAttribute("href", "/launches/l1");
    expect(screen.getByText("Acme")).toBeInTheDocument();
    expect(screen.getByText("Posted")).toBeInTheDocument();
  });

  it("switches to the video table on the Video tab", async () => {
    const user = userEvent.setup();
    render(
      <LaunchesManager
        initialImage={[row({ id: "l1", payload: { brief_id_human: "img-1", client: null } })]}
        initialVideo={[row({ id: "v1", payload: { brief_id_human: "vid-1", client: null } })]}
      />,
    );
    expect(screen.getByRole("link", { name: "img-1" })).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Video" }));
    expect(screen.getByRole("link", { name: "vid-1" })).toHaveAttribute(
      "href",
      "/launches/video/v1",
    );
  });

  it("archives a launch via the row action + confirm dialog", async () => {
    const user = userEvent.setup();
    render(<LaunchesManager initialImage={[row()]} initialVideo={[]} />);
    await user.click(screen.getByRole("button", { name: /row actions/i }));
    await user.click(screen.getByRole("menuitem", { name: /archive/i }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: /^archive$/i }),
    );
    await waitFor(() => expect(archiveLaunch).toHaveBeenCalledWith("image", "l1"));
  });

  it("loads the archived set when the Archived tab opens", async () => {
    listLaunches.mockResolvedValue([
      row({
        id: "arch1",
        payload: { brief_id_human: "arch-1", client: null },
        deleted_at: "2026-01-01",
      }),
    ]);
    const user = userEvent.setup();
    render(<LaunchesManager initialImage={[]} initialVideo={[]} />);
    await user.click(screen.getByRole("tab", { name: "Archived" }));
    await waitFor(() => expect(listLaunches).toHaveBeenCalledWith("image", { archived: true }));
    expect(await screen.findByRole("link", { name: "arch-1" })).toBeInTheDocument();
  });

  it("shows an error banner when the archived load fails", async () => {
    listLaunches.mockRejectedValue(new Error("load failed"));
    const user = userEvent.setup();
    render(<LaunchesManager initialImage={[]} initialVideo={[]} />);
    await user.click(screen.getByRole("tab", { name: "Archived" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/load failed/i);
  });

  it("restores an archived launch via the row action", async () => {
    listLaunches.mockResolvedValue([
      row({ id: "arch1", payload: { brief_id_human: "arch-1", client: null }, deleted_at: "x" }),
    ]);
    const user = userEvent.setup();
    render(<LaunchesManager initialImage={[]} initialVideo={[]} />);
    await user.click(screen.getByRole("tab", { name: "Archived" }));
    await screen.findByRole("link", { name: "arch-1" });
    await user.click(screen.getByRole("button", { name: /row actions/i }));
    await user.click(screen.getByRole("menuitem", { name: /restore/i }));
    await waitFor(() => expect(restoreLaunch).toHaveBeenCalledWith("image", "arch1"));
  });

  it("falls back to the brief id slice + dash client when payload is malformed", () => {
    render(
      <LaunchesManager
        initialImage={[row({ id: "l9", brief_id: "abcdef12-3456-7890", payload: { bad: true } })]}
        initialVideo={[]}
      />,
    );
    // brief link falls back to the brief_id slice; client shows the em dash.
    expect(screen.getByRole("link", { name: "abcdef12" })).toBeInTheDocument();
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("bulk-archives the selected rows", async () => {
    const user = userEvent.setup();
    render(
      <LaunchesManager
        initialImage={[
          row({ id: "l1", payload: { brief_id_human: "br-1", client: null } }),
          row({ id: "l2", payload: { brief_id_human: "br-2", client: null } }),
        ]}
        initialVideo={[]}
      />,
    );
    // Select all rows on the page via the header checkbox.
    await user.click(screen.getByRole("checkbox", { name: /select all rows/i }));
    // The bulk action bar appears; click its Archive.
    const bar = screen.getByRole("region", { name: /bulk actions/i });
    await user.click(within(bar).getByRole("button", { name: /archive/i }));
    // Confirm in the dialog.
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: /^archive$/i }));
    await waitFor(() => expect(archiveLaunch).toHaveBeenCalledTimes(2));
  });
});
