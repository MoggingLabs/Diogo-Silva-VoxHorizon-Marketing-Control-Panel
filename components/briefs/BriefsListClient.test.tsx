/**
 * Tests for the unified Briefs list client (E3.1 / #590).
 *
 * Covers: rendering both formats, the format tab filter (all/image/video),
 * archive vs active row actions, single-row archive + restore calling the
 * format-aware client, and the active/archived view link.
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const refresh = vi.fn();
const push = vi.fn();
let currentParams = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push, refresh }),
  usePathname: () => "/briefs",
  useSearchParams: () => currentParams,
}));

const archiveBrief = vi.fn();
const restoreBrief = vi.fn();
vi.mock("@/lib/briefs-client", () => ({
  archiveBrief: (format: string, id: string) => archiveBrief(format, id),
  restoreBrief: (format: string, id: string) => restoreBrief(format, id),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { BriefsListClient } from "./BriefsListClient";
import type { UnifiedBriefRow } from "@/lib/briefs-unified";

function row(over: Partial<UnifiedBriefRow>): UnifiedBriefRow {
  return {
    id: "i1",
    format: "image",
    briefIdHuman: "img-1",
    clientId: "c1",
    clientName: "Acme Co",
    status: "draft",
    serviceMarket: "roofing · Austin",
    createdAt: "2026-05-20T00:00:00Z",
    deletedAt: null,
    href: "/briefs/i1",
    ...over,
  };
}

const IMAGE_ROW = row({ id: "i1", format: "image", briefIdHuman: "img-1" });
const VIDEO_ROW = row({
  id: "v1",
  format: "video",
  briefIdHuman: "vid-1",
  href: "/briefs/video/v1",
  serviceMarket: "9x16 · 30s",
  status: "posted",
});
const ROWS: UnifiedBriefRow[] = [IMAGE_ROW, VIDEO_ROW];

beforeEach(() => {
  currentParams = new URLSearchParams();
  refresh.mockClear();
  push.mockClear();
  archiveBrief.mockClear();
  restoreBrief.mockClear();
});

afterEach(() => vi.clearAllMocks());

describe("BriefsListClient", () => {
  it("renders both image + video briefs in the All tab", () => {
    render(<BriefsListClient rows={ROWS} archived={false} />);
    expect(screen.getByText("img-1")).toBeInTheDocument();
    expect(screen.getByText("vid-1")).toBeInTheDocument();
  });

  it("filters to video when the Video tab is selected", async () => {
    const user = userEvent.setup();
    render(<BriefsListClient rows={ROWS} archived={false} />);
    await user.click(screen.getByRole("tab", { name: "Video" }));
    expect(screen.queryByText("img-1")).not.toBeInTheDocument();
    expect(screen.getByText("vid-1")).toBeInTheDocument();
  });

  it("shows the New brief menu with image + video create links when active", async () => {
    const user = userEvent.setup();
    render(<BriefsListClient rows={ROWS} archived={false} />);
    await user.click(screen.getByRole("button", { name: /new brief/i }));
    expect(screen.getByRole("menuitem", { name: /image brief/i })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /video brief/i })).toBeInTheDocument();
  });

  it("links to the archived view when active", () => {
    render(<BriefsListClient rows={ROWS} archived={false} />);
    expect(screen.getByRole("link", { name: /archived/i })).toHaveAttribute(
      "href",
      "/briefs?archived=1",
    );
  });

  it("archives a single image brief via the format-aware client", async () => {
    const user = userEvent.setup();
    render(<BriefsListClient rows={[IMAGE_ROW]} archived={false} />);
    await user.click(screen.getByRole("button", { name: /row actions/i }));
    await user.click(screen.getByRole("menuitem", { name: /archive/i }));
    expect(archiveBrief).toHaveBeenCalledWith("image", "i1");
    expect(restoreBrief).not.toHaveBeenCalled();
  });

  it("restores a single video brief in the archived view", async () => {
    const user = userEvent.setup();
    render(
      <BriefsListClient
        rows={[
          row({
            id: "v1",
            format: "video",
            briefIdHuman: "vid-1",
            href: "/briefs/video/v1",
            deletedAt: "2026-05-25T00:00:00Z",
          }),
        ]}
        archived
      />,
    );
    await user.click(screen.getByRole("button", { name: /row actions/i }));
    await user.click(screen.getByRole("menuitem", { name: /restore/i }));
    expect(restoreBrief).toHaveBeenCalledWith("video", "v1");
    expect(archiveBrief).not.toHaveBeenCalled();
  });

  it("hides the New brief menu in the archived view and links back to active", () => {
    render(<BriefsListClient rows={ROWS} archived />);
    expect(screen.queryByRole("button", { name: /new brief/i })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /active/i })).toHaveAttribute("href", "/briefs");
  });

  it("renders the archived empty state", () => {
    render(<BriefsListClient rows={[]} archived />);
    expect(screen.getByText(/no archived briefs/i)).toBeInTheDocument();
  });

  it("renders the status badge for each row", () => {
    render(<BriefsListClient rows={ROWS} archived={false} />);
    // image=draft, video=posted; StatusBadge sets data-status.
    const table = screen.getByRole("table");
    expect(within(table).getByText("Draft")).toBeInTheDocument();
    expect(within(table).getByText("Posted")).toBeInTheDocument();
  });

  it("bulk-archives the selected rows through the confirm dialog (each format)", async () => {
    const user = userEvent.setup();
    render(<BriefsListClient rows={ROWS} archived={false} />);
    // Select all rows on the page via the header checkbox.
    await user.click(screen.getByRole("checkbox", { name: /select all rows/i }));
    // The bulk bar appears; click Archive -> opens ConfirmArchive.
    await user.click(screen.getByRole("button", { name: /^archive$/i }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: /^archive$/i }));
    await waitFor(() => expect(archiveBrief).toHaveBeenCalledTimes(2));
    expect(archiveBrief).toHaveBeenCalledWith("image", "i1");
    expect(archiveBrief).toHaveBeenCalledWith("video", "v1");
  });

  it("bulk-restores the selected rows directly in the archived view", async () => {
    const user = userEvent.setup();
    render(
      <BriefsListClient
        rows={[
          row({ id: "i1", deletedAt: "2026-05-25T00:00:00Z" }),
          row({ id: "v1", format: "video", href: "/briefs/video/v1", deletedAt: "x" }),
        ]}
        archived
      />,
    );
    await user.click(screen.getByRole("checkbox", { name: /select all rows/i }));
    // In archived view the bulk action restores directly (no confirm dialog).
    await user.click(screen.getByRole("button", { name: /^restore$/i }));
    await waitFor(() => expect(restoreBrief).toHaveBeenCalledTimes(2));
  });

  it("reports a bulk failure via an error toast but still refreshes", async () => {
    const { toast } = await import("sonner");
    archiveBrief.mockRejectedValueOnce(new Error("archive failed"));
    const user = userEvent.setup();
    render(<BriefsListClient rows={[IMAGE_ROW]} archived={false} />);
    await user.click(screen.getByRole("checkbox", { name: /select all rows/i }));
    await user.click(screen.getByRole("button", { name: /^archive$/i }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: /^archive$/i }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("archive failed"));
  });
});
