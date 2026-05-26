/**
 * Tests for the global command palette (Makeover M7 live search).
 *
 * Two modes: navigation (empty query) and debounced live `/api/search` results.
 * `searchResources` is mocked so we assert wiring without a real network call.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

const searchResources = vi.fn();
vi.mock("@/lib/search/client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/search/client")>("@/lib/search/client");
  return { ...actual, searchResources: (...args: unknown[]) => searchResources(...args) };
});

import { CommandPalette } from "./CommandPalette";

beforeEach(() => {
  searchResources.mockReset();
  push.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("CommandPalette navigation mode", () => {
  it("does not render its content when closed", () => {
    render(<CommandPalette open={false} onOpenChange={vi.fn()} />);
    expect(screen.queryByText("Dashboard")).not.toBeInTheDocument();
  });

  it("lists navigation commands when open with an empty query", () => {
    render(<CommandPalette open onOpenChange={vi.fn()} />);
    expect(screen.getByText("Dashboard")).toBeInTheDocument();
    expect(screen.getByText("Operator Console")).toBeInTheDocument();
    expect(screen.getByText("Clients")).toBeInTheDocument();
    // No search performed for the empty home view.
    expect(searchResources).not.toHaveBeenCalled();
  });

  it("renders the keyboard shortcut hints on the navigation view", () => {
    render(<CommandPalette open onOpenChange={vi.fn()} />);
    const hint = screen.getByRole("note", { name: /keyboard shortcuts/i });
    expect(hint).toBeInTheDocument();
    expect(hint).toHaveTextContent(/n.*new/i);
    expect(hint).toHaveTextContent(/e.*edit/i);
  });

  it("navigates and closes on selecting a nav item", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(<CommandPalette open onOpenChange={onOpenChange} />);
    await user.click(screen.getByText("Clients"));
    expect(push).toHaveBeenCalledWith("/clients");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

describe("CommandPalette live search", () => {
  it("debounces, queries /api/search, and renders grouped results", async () => {
    searchResources.mockResolvedValue([
      { kind: "client", id: "c1", label: "Acme Roofing", href: "/clients/c1" },
      { kind: "brief", id: "b1", label: "ROOF-001", href: "/briefs/b1" },
    ]);
    const user = userEvent.setup();
    render(<CommandPalette open onOpenChange={vi.fn()} />);

    await user.type(screen.getByPlaceholderText(/search clients/i), "roof");

    await waitFor(() => expect(searchResources).toHaveBeenCalled());
    expect(searchResources.mock.calls.at(-1)?.[0]).toBe("roof");

    expect(await screen.findByText("Acme Roofing")).toBeInTheDocument();
    expect(screen.getByText("ROOF-001")).toBeInTheDocument();
    // group headings present
    expect(screen.getByText("Clients")).toBeInTheDocument();
    expect(screen.getByText("Briefs")).toBeInTheDocument();
    // nav list is gone in search mode
    expect(screen.queryByText("Dashboard")).not.toBeInTheDocument();
  });

  it("deep-links to a result href and closes on select", async () => {
    searchResources.mockResolvedValue([
      { kind: "launch_package", id: "lp1", label: "Launch approved", href: "/launches/lp1" },
    ]);
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(<CommandPalette open onOpenChange={onOpenChange} />);
    await user.type(screen.getByPlaceholderText(/search clients/i), "launch");
    const item = await screen.findByText("Launch approved");
    await user.click(item);
    expect(push).toHaveBeenCalledWith("/launches/lp1");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("shows the empty state when search returns nothing", async () => {
    searchResources.mockResolvedValue([]);
    const user = userEvent.setup();
    render(<CommandPalette open onOpenChange={vi.fn()} />);
    await user.type(screen.getByPlaceholderText(/search clients/i), "zzz");
    expect(await screen.findByText(/no results for/i)).toBeInTheDocument();
  });

  it("swallows a rejected search and clears results (no crash)", async () => {
    searchResources.mockRejectedValue(new Error("network"));
    const user = userEvent.setup();
    render(<CommandPalette open onOpenChange={vi.fn()} />);
    await user.type(screen.getByPlaceholderText(/search clients/i), "boom");
    // Falls through to the empty state once the rejected promise settles.
    expect(await screen.findByText(/no results for/i)).toBeInTheDocument();
  });

  it("ignores an AbortError without clearing prior UI state", async () => {
    searchResources.mockRejectedValue(new DOMException("Aborted", "AbortError"));
    const user = userEvent.setup();
    render(<CommandPalette open onOpenChange={vi.fn()} />);
    await user.type(screen.getByPlaceholderText(/search clients/i), "ab");
    // The loading indicator stays (abort handler returns early, never resolves
    // loading=false), so no empty state is shown.
    await waitFor(() => expect(searchResources).toHaveBeenCalled());
    expect(screen.queryByText(/no results for/i)).not.toBeInTheDocument();
  });

  it("renders icons for every result kind without crashing", async () => {
    searchResources.mockResolvedValue([
      { kind: "client", id: "c1", label: "C", href: "/clients/c1" },
      { kind: "brief", id: "b1", label: "B", href: "/briefs/b1" },
      { kind: "video_brief", id: "vb1", label: "VB", href: "/briefs/vb1?format=video" },
      { kind: "creative", id: "cr1", label: "CR", href: "/creatives/b1" },
      { kind: "video_creative", id: "vcr1", label: "VCR", href: "/creatives/vb1?format=video" },
      { kind: "launch_package", id: "lp1", label: "LP", href: "/launches/lp1" },
      {
        kind: "video_launch_package",
        id: "vlp1",
        label: "VLP",
        href: "/launches/vlp1?format=video",
      },
      { kind: "pipeline", id: "p1", label: "PL", href: "/pipeline/p1" },
    ]);
    const user = userEvent.setup();
    render(<CommandPalette open onOpenChange={vi.fn()} />);
    await user.type(screen.getByPlaceholderText(/search clients/i), "all");
    // Every label appears -> every icon branch in resultIcon ran.
    for (const label of ["C", "B", "VB", "CR", "VCR", "LP", "VLP", "PL"]) {
      expect(await screen.findByText(label)).toBeInTheDocument();
    }
  });

  it("resets query + results when the palette closes", async () => {
    searchResources.mockResolvedValue([
      { kind: "client", id: "c1", label: "Acme", href: "/clients/c1" },
    ]);
    const user = userEvent.setup();
    const { rerender } = render(<CommandPalette open onOpenChange={vi.fn()} />);
    await user.type(screen.getByPlaceholderText(/search clients/i), "acme");
    expect(await screen.findByText("Acme")).toBeInTheDocument();

    rerender(<CommandPalette open={false} onOpenChange={vi.fn()} />);
    rerender(<CommandPalette open onOpenChange={vi.fn()} />);
    // Reopened clean: nav list shows again, no stale result.
    expect(screen.getByText("Dashboard")).toBeInTheDocument();
    expect(screen.queryByText("Acme")).not.toBeInTheDocument();
  });
});
