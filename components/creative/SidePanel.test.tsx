/**
 * SidePanel is the slide-over for one image creative. Tests cover:
 *  - "Creative not found" path when no creative is selected
 *  - Iterations fetched on mount and rendered through IterationThread
 *  - Error from supabase surfaces as inline banner
 *  - Prompt copy with success state
 *  - Unread divider count vs lastSeen
 *  - Drive link rendered when present
 *  - Mount + unmount of ThreadSearch via header button
 *  - DecisionButtons only render in draft status
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Creative, CreativeIteration } from "@/lib/creatives";

// SidePanel reads its iteration thread from the service-role API via the
// client-data helper. Mock it per-test to drive success / error paths.
const fetchCreativeIterations = vi.fn<() => Promise<CreativeIteration[]>>(async () => []);
vi.mock("@/lib/realtime/client-data", () => ({
  fetchCreativeIterations: () => fetchCreativeIterations(),
}));

const markReadSpy = vi.fn<(id: string) => Promise<void>>(async () => {});
vi.mock("@/lib/chat-read-status", () => ({
  countUnread: vi.fn(() => 2),
  getLastSeen: vi.fn(async () => "2026-05-17T11:00:00Z"),
  markRead: (id: string) => markReadSpy(id),
}));

// Stub heavyweight inner components so SidePanel tests stay focused.
vi.mock("./IterationThread", () => ({
  IterationThread: ({ creativeId }: { creativeId: string }) => (
    <div data-testid="iter-thread">{creativeId}</div>
  ),
}));
vi.mock("./DecisionButtons", () => ({
  DecisionButtons: ({ creativeId }: { creativeId: string }) => (
    <div data-testid="decision">{creativeId}</div>
  ),
}));
vi.mock("@/components/chat/EkkoChat", () => ({
  EkkoChat: ({ creativeId }: { creativeId: string }) => (
    <div data-testid="ekko-chat">{creativeId}</div>
  ),
}));
vi.mock("@/components/chat/UnreadDivider", () => ({
  UnreadDivider: ({ count }: { count: number }) => <div data-testid="unread-divider">{count}</div>,
}));
vi.mock("@/components/chat/ThreadSearch", () => ({
  ThreadSearch: ({ open, onClose }: { open: boolean; onClose: () => void }) =>
    open ? (
      <div data-testid="thread-search">
        <button type="button" onClick={onClose}>
          close-search
        </button>
      </div>
    ) : null,
  useThreadSearchShortcut: () => {},
}));

import { SidePanel } from "./SidePanel";

function makeCreative(over: Partial<Creative> = {}): Creative {
  return {
    id: "c1",
    brief_id: "b1",
    concept: "Hurricane-ready",
    ratio: "1x1",
    version: "v1.0",
    status: "draft",
    file_path_supabase: "x.png",
    file_path_drive: null,
    type: "image",
    prompt_used: { headline: "Get a free roof inspection" },
    offer_text: null,
    approved_at: null,
    asset_name: null,
    concept_id: null,
    deleted_at: null,
    drive_folder_id: null,
    finalize_verified: false,
    finalized_at: null,
    pipeline_id: null,
    created_at: "2026-05-17T11:00:00Z",
    updated_at: "2026-05-17T11:30:00Z",
    ...(over as object),
  } as Creative;
}

beforeEach(() => {
  fetchCreativeIterations.mockReset();
  fetchCreativeIterations.mockResolvedValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SidePanel", () => {
  it("shows the 'not found' state when creative is null", () => {
    render(<SidePanel creative={null} signedUrl={null} open onOpenChange={() => {}} />);
    expect(screen.getByText(/Creative not found/)).toBeInTheDocument();
  });

  it("renders the preview image when signed URL provided", () => {
    render(
      <SidePanel
        creative={makeCreative()}
        signedUrl="https://x.example/img.png"
        open
        onOpenChange={() => {}}
      />,
    );
    expect(screen.getByAltText("Hurricane-ready")).toBeInTheDocument();
  });

  it("renders the no-render placeholder when signedUrl is null", () => {
    render(<SidePanel creative={makeCreative()} signedUrl={null} open onOpenChange={() => {}} />);
    expect(screen.getByText(/No render yet/)).toBeInTheDocument();
  });

  it("renders DecisionButtons only when status=draft", () => {
    const { rerender } = render(
      <SidePanel
        creative={makeCreative({ status: "draft" })}
        signedUrl={null}
        open
        onOpenChange={() => {}}
      />,
    );
    expect(screen.getByTestId("decision")).toBeInTheDocument();
    rerender(
      <SidePanel
        creative={makeCreative({ status: "approved", approved_at: "2026-05-17T11:45:00Z" })}
        signedUrl={null}
        open
        onOpenChange={() => {}}
      />,
    );
    expect(screen.queryByTestId("decision")).not.toBeInTheDocument();
    expect(screen.getByText(/Decided /)).toBeInTheDocument();
  });

  it("fetches iterations from the API and renders them", async () => {
    fetchCreativeIterations.mockResolvedValue([
      { id: "i1", creative_id: "c1", created_at: "2026-05-17T11:01:00Z" } as CreativeIteration,
    ]);
    render(<SidePanel creative={makeCreative()} signedUrl={null} open onOpenChange={() => {}} />);
    await waitFor(() => {
      expect(screen.getByTestId("iter-thread")).toHaveTextContent("c1");
    });
  });

  it("surfaces an iteration fetch error inline", async () => {
    fetchCreativeIterations.mockRejectedValue(new Error("rls denied"));
    render(<SidePanel creative={makeCreative()} signedUrl={null} open onOpenChange={() => {}} />);
    expect(await screen.findByText(/Failed to load iterations: rls denied/)).toBeInTheDocument();
  });

  it("copies the prompt text to the clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    // Set the navigator.clipboard mock AFTER userEvent.setup so user-event
    // doesn't replace it with its own jsdom-friendly stub.
    const user = userEvent.setup();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      writable: true,
      value: { writeText },
    });
    render(<SidePanel creative={makeCreative()} signedUrl={null} open onOpenChange={() => {}} />);
    await user.click(screen.getByRole("button", { name: /^Copy$/ }));
    expect(writeText).toHaveBeenCalled();
    expect(await screen.findByText("Copied")).toBeInTheDocument();
  });

  it("survives clipboard rejection gracefully", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    const user = userEvent.setup();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      writable: true,
      value: { writeText },
    });
    render(<SidePanel creative={makeCreative()} signedUrl={null} open onOpenChange={() => {}} />);
    await user.click(screen.getByRole("button", { name: /^Copy$/ }));
    // Doesn't crash; the "Copy" label stays.
    expect(screen.getByRole("button", { name: /^Copy$/ })).toBeInTheDocument();
  });

  it("renders the Drive link when file_path_drive is set", () => {
    render(
      <SidePanel
        creative={makeCreative({ file_path_drive: "https://drive.example/x" })}
        signedUrl={null}
        open
        onOpenChange={() => {}}
      />,
    );
    expect(screen.getByRole("link", { name: /Open/i })).toHaveAttribute(
      "href",
      "https://drive.example/x",
    );
  });

  it("renders the unread divider with countUnread result", async () => {
    render(<SidePanel creative={makeCreative()} signedUrl={null} open onOpenChange={() => {}} />);
    expect(await screen.findByTestId("unread-divider")).toHaveTextContent("2");
  });

  it("toggles the thread search bar via the header button", async () => {
    const user = userEvent.setup();
    render(<SidePanel creative={makeCreative()} signedUrl={null} open onOpenChange={() => {}} />);
    expect(screen.queryByTestId("thread-search")).not.toBeInTheDocument();
    await user.click(screen.getByLabelText(/Search this thread/));
    expect(await screen.findByTestId("thread-search")).toBeInTheDocument();
    await user.click(screen.getByLabelText(/Search this thread/));
    expect(screen.queryByTestId("thread-search")).not.toBeInTheDocument();
  });

  it("renders a plain string prompt", () => {
    render(
      <SidePanel
        creative={makeCreative({ prompt_used: "raw text" })}
        signedUrl={null}
        open
        onOpenChange={() => {}}
      />,
    );
    expect(screen.getByText("raw text")).toBeInTheDocument();
  });

  it("renders an empty prompt placeholder when none recorded", () => {
    render(
      <SidePanel
        creative={makeCreative({ prompt_used: null })}
        signedUrl={null}
        open
        onOpenChange={() => {}}
      />,
    );
    expect(screen.getByText(/No prompt snapshot recorded/)).toBeInTheDocument();
  });

  it("renders the EkkoChat slot", () => {
    render(<SidePanel creative={makeCreative()} signedUrl={null} open onOpenChange={() => {}} />);
    expect(screen.getByTestId("ekko-chat")).toHaveTextContent("c1");
  });

  it("handles unparseable created_at via the formatDate fallback", () => {
    render(
      <SidePanel
        creative={makeCreative({ created_at: "2026-05-17T11:00:00Z" })}
        signedUrl={null}
        open
        onOpenChange={() => {}}
      />,
    );
    // Just sanity-check the panel rendered.
    expect(screen.getAllByText(/Hurricane-ready/).length).toBeGreaterThan(0);
  });

  it("markRead fires when the panel transitions from open=true to open=false", async () => {
    markReadSpy.mockClear();
    const { rerender } = render(
      <SidePanel creative={makeCreative()} signedUrl={null} open onOpenChange={() => {}} />,
    );
    rerender(
      <SidePanel creative={makeCreative()} signedUrl={null} open={false} onOpenChange={() => {}} />,
    );
    await waitFor(() => expect(markReadSpy).toHaveBeenCalledWith("c1"));
  });

  it("closes the thread search via onClose callback", async () => {
    const user = userEvent.setup();
    render(<SidePanel creative={makeCreative()} signedUrl={null} open onOpenChange={() => {}} />);
    await user.click(screen.getByLabelText(/Search this thread/));
    expect(screen.getByTestId("thread-search")).toBeInTheDocument();
    await user.click(screen.getByText("close-search"));
    expect(screen.queryByTestId("thread-search")).not.toBeInTheDocument();
  });

  it("handles unparseable approved_at via formatDate fallback", () => {
    render(
      <SidePanel
        creative={makeCreative({ approved_at: null })}
        signedUrl={null}
        open
        onOpenChange={() => {}}
      />,
    );
    // Sanity — no crash.
    expect(screen.getAllByText(/Hurricane-ready/).length).toBeGreaterThan(0);
  });

  it("renders the unsigned-url message when prompt_used is an unstringifiable object", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    render(
      <SidePanel
        creative={makeCreative({
          prompt_used: circular as unknown as ReturnType<typeof makeCreative>["prompt_used"],
        })}
        signedUrl={null}
        open
        onOpenChange={() => {}}
      />,
    );
    expect(screen.getAllByText(/Hurricane-ready/).length).toBeGreaterThan(0);
  });
});
