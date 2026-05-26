/**
 * CreativesGrid (E4.1 / #593): the unified image + video creatives surface.
 * Tests cover the format tabs + counts, the grid/table view toggle, the
 * archive flow (ConfirmArchive -> archiveCreative -> refresh), the lazy
 * archived view fetch + restore, and the empty states.
 */
import { render, screen, within, act, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CreativeRow } from "@/lib/creatives-rows";

const routerRefresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: routerRefresh, push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/creatives",
  useSearchParams: () => new URLSearchParams(),
}));

const archiveCreativeMock = vi.fn();
const restoreCreativeMock = vi.fn();
vi.mock("@/lib/creatives-client", () => ({
  archiveCreative: (...args: unknown[]) => archiveCreativeMock(...args),
  restoreCreative: (...args: unknown[]) => restoreCreativeMock(...args),
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { CreativesGrid } from "./CreativesGrid";

function row(over: Partial<CreativeRow> = {}): CreativeRow {
  return {
    id: "c1",
    kind: "image",
    brief_id: "b1",
    brief_label: "br-1",
    concept: "Roof hook",
    format_label: "1x1",
    status: "draft",
    version: "v1",
    created_at: "2026-05-20T10:00:00Z",
    thumbnail_url: null,
    href: "/creatives/manage/c1",
    ...over,
  };
}

const fetchMock = vi.fn();

beforeEach(() => {
  routerRefresh.mockReset();
  archiveCreativeMock.mockReset().mockResolvedValue(undefined);
  restoreCreativeMock.mockReset().mockResolvedValue(undefined);
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("CreativesGrid", () => {
  it("renders the thumbnail grid with format-tab counts", () => {
    render(
      <CreativesGrid
        initialRows={[
          row({ id: "c1", kind: "image" }),
          row({ id: "v1", kind: "video", href: "/creatives/manage/video/v1", concept: "Hero" }),
        ]}
      />,
    );
    // "All 2", "Image 1", "Video 1"
    const tablist = screen.getByRole("tablist", { name: /creative format/i });
    expect(within(tablist).getByRole("tab", { name: /all/i })).toHaveTextContent("2");
    expect(within(tablist).getByRole("tab", { name: /image/i })).toHaveTextContent("1");
    expect(within(tablist).getByRole("tab", { name: /video/i })).toHaveTextContent("1");
    // Both concept titles are visible in the grid cards.
    expect(screen.getByText("Roof hook")).toBeInTheDocument();
    expect(screen.getByText("Hero")).toBeInTheDocument();
  });

  it("filters by the Video tab", async () => {
    const user = userEvent.setup();
    render(
      <CreativesGrid
        initialRows={[
          row({ id: "c1", kind: "image", concept: "Image one" }),
          row({
            id: "v1",
            kind: "video",
            href: "/creatives/manage/video/v1",
            concept: "Video one",
          }),
        ]}
      />,
    );
    await user.click(screen.getByRole("tab", { name: /video/i }));
    expect(screen.queryByText("Image one")).not.toBeInTheDocument();
    expect(screen.getByText("Video one")).toBeInTheDocument();
  });

  it("toggles between table and grid views (renders thumbnail + format cells)", async () => {
    const user = userEvent.setup();
    render(
      <CreativesGrid
        initialRows={[
          // An unparseable created_at exercises the date-format fallback.
          row({
            thumbnail_url: "https://signed/p.png",
            format_label: "9x16",
            created_at: "not-a-date",
          }),
        ]}
      />,
    );
    await user.click(screen.getByRole("button", { name: /table view/i }));
    // The DataTable renders a real <table> with a Brief column header.
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: /brief/i })).toBeInTheDocument();
    // The format cell shows the ratio label.
    expect(screen.getByText(/9x16/)).toBeInTheDocument();
    // Toggle back to the grid view.
    await user.click(screen.getByRole("button", { name: /grid view/i }));
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("archives from the table-view row action menu", async () => {
    const user = userEvent.setup();
    render(<CreativesGrid initialRows={[row({ id: "c7" })]} />);
    await user.click(screen.getByRole("button", { name: /table view/i }));
    await user.click(screen.getByRole("button", { name: /row actions/i }));
    await user.click(await screen.findByRole("menuitem", { name: /archive/i }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: /^archive$/i }));
    await waitFor(() => expect(archiveCreativeMock).toHaveBeenCalledWith("image", "c7"));
  });

  it("restores from the table-view row action menu in the archived view", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ rows: [row({ id: "a7", brief_label: "br-a7", format_label: null })] }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );
    render(<CreativesGrid initialRows={[]} />);
    await user.click(screen.getByRole("button", { name: /show archived/i }));
    await screen.findByText("br-a7");
    await user.click(screen.getByRole("button", { name: /table view/i }));
    await user.click(screen.getByRole("button", { name: /row actions/i }));
    await user.click(await screen.findByRole("menuitem", { name: /restore/i }));
    await waitFor(() => expect(restoreCreativeMock).toHaveBeenCalledWith("image", "a7"));
  });

  it("toasts when a grid restore fails", async () => {
    const user = userEvent.setup();
    const { toast } = await import("sonner");
    restoreCreativeMock.mockRejectedValueOnce(new Error("restore boom"));
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ rows: [row({ id: "a8", brief_label: "br-a8" })] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    render(<CreativesGrid initialRows={[]} />);
    await user.click(screen.getByRole("button", { name: /show archived/i }));
    await user.click(await screen.findByRole("button", { name: /restore creative br-a8/i }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("restore boom"));
  });

  it("archives a creative through the confirm dialog", async () => {
    const user = userEvent.setup();
    render(<CreativesGrid initialRows={[row({ id: "c9" })]} />);
    // Click the card's Archive button.
    await user.click(screen.getByRole("button", { name: /archive creative br-1/i }));
    // Confirm dialog opens; confirm.
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: /^archive$/i }));
    await waitFor(() => expect(archiveCreativeMock).toHaveBeenCalledWith("image", "c9"));
    expect(routerRefresh).toHaveBeenCalled();
  });

  it("lazily loads + restores from the archived view", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          rows: [row({ id: "a1", brief_label: "br-arch" })],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    render(<CreativesGrid initialRows={[]} />);
    await user.click(screen.getByRole("button", { name: /show archived/i }));
    // Fetches the archived endpoint.
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/api/creatives/archived", { cache: "no-store" }),
    );
    // The archived row renders with a Restore action.
    const restoreBtn = await screen.findByRole("button", { name: /restore creative br-arch/i });
    await user.click(restoreBtn);
    await waitFor(() => expect(restoreCreativeMock).toHaveBeenCalledWith("image", "a1"));
  });

  it("shows the empty state when there are no creatives", () => {
    render(<CreativesGrid initialRows={[]} />);
    expect(screen.getByText(/No creatives yet/i)).toBeInTheDocument();
  });

  it("surfaces an archived load error", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValueOnce(new Response("nope", { status: 500 }));
    render(<CreativesGrid initialRows={[]} />);
    await act(async () => {
      await user.click(screen.getByRole("button", { name: /show archived/i }));
    });
    expect(await screen.findByText(/Failed to load archived creatives/i)).toBeInTheDocument();
  });

  it("exports the visible creatives via the toolbar Export button", async () => {
    const RealBlob = globalThis.Blob;
    const captured: { content: string; type: string }[] = [];
    vi.stubGlobal(
      "Blob",
      class MockBlob {
        content: string;
        type: string;
        constructor(parts: BlobPart[], options?: BlobPropertyBag) {
          this.content = parts.map(String).join("");
          this.type = options?.type ?? "";
          captured.push({ content: this.content, type: this.type });
        }
      },
    );
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:mock");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    try {
      const user = userEvent.setup();
      render(
        <CreativesGrid
          initialRows={[
            row({ id: "c1", kind: "image", concept: "Hero hook" }),
            row({ id: "v1", kind: "video", href: "/creatives/manage/video/v1" }),
          ]}
        />,
      );
      await user.click(screen.getByRole("button", { name: /^export$/i }));
      await user.click(await screen.findByText("Export as CSV"));
      expect(captured).toHaveLength(1);
      const lines = captured[0]!.content.split("\r\n");
      expect(lines[0]).toBe("Brief,Concept,Format,Status,Version,Created");
      expect(lines.length).toBeGreaterThan(1);
    } finally {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
      globalThis.Blob = RealBlob;
    }
  });

  it("disables the Export button when no rows are visible", () => {
    render(<CreativesGrid initialRows={[]} />);
    expect(screen.getByRole("button", { name: /^export$/i })).toBeDisabled();
  });
});
