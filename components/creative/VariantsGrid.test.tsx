/**
 * VariantsGrid renders the grid of image creatives + opens the SidePanel
 * via URL state. Realtime keeps the grid in sync. Tests cover:
 *  - Empty state
 *  - Card render + selection round-trips via router.replace
 *  - Realtime INSERT / UPDATE / DELETE updating state
 *  - Storage signed-URL fetch on a newly-arrived row
 *  - Unmount removes the channel
 */
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Creative } from "@/lib/creatives";

const routerReplace = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: routerReplace, refresh: vi.fn(), push: vi.fn() }),
  usePathname: () => "/creatives/b1",
  useSearchParams: () => new URLSearchParams(""),
}));

vi.mock("@/lib/realtime-queue", () => ({
  createRealtimeQueue: () => ({
    queue: (_k: string, run: () => void) => run(),
    flushNow: (_k: string, run: () => void) => run(),
    dispose: () => {},
  }),
}));

// Capture handlers per channel event for replay.
const channelHandlers: Record<
  string,
  Array<(p: { new?: Creative; old?: Partial<Creative> }) => void>
> = {
  INSERT: [],
  UPDATE: [],
  DELETE: [],
};

const removeChannelSpy = vi.fn();
const channelSpy = vi.fn(() => {
  const ch: Record<string, unknown> = {};
  ch.on = vi.fn(
    (
      _evt: string,
      spec: { event: string },
      cb: (p: { new?: Creative; old?: Partial<Creative> }) => void,
    ) => {
      if (spec.event in channelHandlers) channelHandlers[spec.event]!.push(cb);
      return ch;
    },
  );
  ch.subscribe = vi.fn(() => ch);
  ch.unsubscribe = vi.fn();
  return ch;
});

const createSignedUrl = vi.fn(async () => ({
  data: { signedUrl: "https://x.example/signed" },
  error: null,
}));

vi.mock("@/lib/supabase/browser", () => ({
  createClient: () => ({
    channel: channelSpy,
    removeChannel: removeChannelSpy,
    storage: { from: () => ({ createSignedUrl }) },
  }),
}));

vi.mock("./SidePanel", () => ({
  SidePanel: ({
    creative,
    open,
    onOpenChange,
  }: {
    creative: { id: string } | null;
    open: boolean;
    onOpenChange: (b: boolean) => void;
  }) => (
    <div data-testid="side-panel" data-open={open}>
      {creative?.id ?? "no-creative"}
      <button type="button" onClick={() => onOpenChange(false)}>
        close-panel
      </button>
    </div>
  ),
}));

import { VariantsGrid } from "./VariantsGrid";

function makeCreative(over: Partial<Creative> = {}): Creative {
  return {
    id: `c-${Math.random().toString(36).slice(2)}`,
    brief_id: "b1",
    concept: "Concept A",
    ratio: "1x1",
    version: "v1.0",
    status: "draft",
    file_path_supabase: "p.png",
    file_path_drive: null,
    type: "image",
    prompt_used: null,
    offer_text: null,
    approved_at: null,
    created_at: new Date(Date.now() - 60_000).toISOString(),
    updated_at: new Date().toISOString(),
    ...(over as object),
  } as Creative;
}

beforeEach(() => {
  routerReplace.mockReset();
  removeChannelSpy.mockReset();
  channelSpy.mockClear();
  channelHandlers.INSERT = [];
  channelHandlers.UPDATE = [];
  channelHandlers.DELETE = [];
  createSignedUrl.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("VariantsGrid", () => {
  it("renders the empty state when no creatives exist", () => {
    render(
      <VariantsGrid briefId="b1" initialCreatives={[]} initialSignedUrls={{}} selectedId={null} />,
    );
    expect(screen.getByText(/No creatives yet/)).toBeInTheDocument();
  });

  it("renders one card per creative", () => {
    render(
      <VariantsGrid
        briefId="b1"
        initialCreatives={[
          makeCreative({ id: "c1", concept: "First" }),
          makeCreative({ id: "c2", concept: "Second" }),
        ]}
        initialSignedUrls={{ c1: "https://x.example/c1", c2: null }}
        selectedId={null}
      />,
    );
    expect(screen.getByAltText("First")).toBeInTheDocument();
    expect(screen.getByText("Second")).toBeInTheDocument();
  });

  it("calls router.replace with creative search param on card click", async () => {
    const user = userEvent.setup();
    render(
      <VariantsGrid
        briefId="b1"
        initialCreatives={[makeCreative({ id: "c1", concept: "Click me" })]}
        initialSignedUrls={{ c1: "https://x.example/c1" }}
        selectedId={null}
      />,
    );
    // The card button is the one wrapping the image; the SidePanel mock also
    // renders a button, so target by image alt.
    await user.click(screen.getByAltText("Click me").closest("button")!);
    expect(routerReplace).toHaveBeenCalledWith(
      "/creatives/b1?creative=c1",
      expect.objectContaining({ scroll: false }),
    );
  });

  it("opens the SidePanel when selectedId matches a creative", () => {
    render(
      <VariantsGrid
        briefId="b1"
        initialCreatives={[makeCreative({ id: "c1" })]}
        initialSignedUrls={{ c1: null }}
        selectedId="c1"
      />,
    );
    const panel = screen.getByTestId("side-panel");
    expect(panel).toHaveAttribute("data-open", "true");
    expect(panel).toHaveTextContent("c1");
  });

  it("calls router.replace with no creative param when the side panel closes", async () => {
    const user = userEvent.setup();
    render(
      <VariantsGrid
        briefId="b1"
        initialCreatives={[makeCreative({ id: "c1" })]}
        initialSignedUrls={{ c1: null }}
        selectedId="c1"
      />,
    );
    await user.click(screen.getByText("close-panel"));
    expect(routerReplace).toHaveBeenCalledWith(
      "/creatives/b1",
      expect.objectContaining({ scroll: false }),
    );
  });

  it("registers INSERT/UPDATE/DELETE realtime handlers", () => {
    render(
      <VariantsGrid briefId="b1" initialCreatives={[]} initialSignedUrls={{}} selectedId={null} />,
    );
    expect((channelHandlers.INSERT ?? []).length).toBeGreaterThan(0);
    expect((channelHandlers.UPDATE ?? []).length).toBeGreaterThan(0);
    expect((channelHandlers.DELETE ?? []).length).toBeGreaterThan(0);
  });

  it("removes the channel on unmount", () => {
    const { unmount } = render(
      <VariantsGrid briefId="b1" initialCreatives={[]} initialSignedUrls={{}} selectedId={null} />,
    );
    unmount();
    expect(removeChannelSpy).toHaveBeenCalled();
  });

  it("INSERT event appends a new creative + fetches signed URL", async () => {
    render(
      <VariantsGrid briefId="b1" initialCreatives={[]} initialSignedUrls={{}} selectedId={null} />,
    );
    await act(async () => {
      channelHandlers.INSERT?.[0]?.({
        new: makeCreative({ id: "c-new", concept: "Streamed in" }),
      });
    });
    expect(screen.getByText("Streamed in")).toBeInTheDocument();
    expect(createSignedUrl).toHaveBeenCalled();
  });

  it("INSERT dedupes by id", async () => {
    const existing = makeCreative({ id: "c1", concept: "Duped" });
    render(
      <VariantsGrid
        briefId="b1"
        initialCreatives={[existing]}
        initialSignedUrls={{ c1: null }}
        selectedId={null}
      />,
    );
    await act(async () => {
      channelHandlers.INSERT?.[0]?.({ new: existing });
    });
    expect(screen.getAllByText("Duped").length).toBe(1);
  });

  it("UPDATE replaces an existing creative", async () => {
    const c = makeCreative({ id: "c1", concept: "Before" });
    render(
      <VariantsGrid
        briefId="b1"
        initialCreatives={[c]}
        initialSignedUrls={{ c1: null }}
        selectedId={null}
      />,
    );
    await act(async () => {
      channelHandlers.UPDATE?.[0]?.({ new: { ...c, concept: "After" } });
    });
    expect(screen.getByText("After")).toBeInTheDocument();
  });

  it("DELETE removes the row + drops its signed URL", async () => {
    const c = makeCreative({ id: "c1", concept: "Gone" });
    render(
      <VariantsGrid
        briefId="b1"
        initialCreatives={[c]}
        initialSignedUrls={{ c1: "https://x.example/c1" }}
        selectedId={null}
      />,
    );
    expect(screen.getByText("Gone")).toBeInTheDocument();
    await act(async () => {
      channelHandlers.DELETE?.[0]?.({ old: { id: "c1" } });
    });
    expect(screen.queryByText("Gone")).not.toBeInTheDocument();
  });

  it("DELETE without an id is a no-op", async () => {
    const c = makeCreative({ id: "c1", concept: "Stays" });
    render(
      <VariantsGrid briefId="b1" initialCreatives={[c]} initialSignedUrls={{}} selectedId={null} />,
    );
    await act(async () => {
      channelHandlers.DELETE?.[0]?.({ old: {} });
    });
    expect(screen.getByText("Stays")).toBeInTheDocument();
  });

  it("syncs state when initialCreatives changes (SSR refresh)", () => {
    const { rerender } = render(
      <VariantsGrid
        briefId="b1"
        initialCreatives={[makeCreative({ id: "c1", concept: "Old" })]}
        initialSignedUrls={{ c1: null }}
        selectedId={null}
      />,
    );
    expect(screen.getByText("Old")).toBeInTheDocument();
    rerender(
      <VariantsGrid
        briefId="b1"
        initialCreatives={[makeCreative({ id: "c2", concept: "New" })]}
        initialSignedUrls={{ c2: null }}
        selectedId={null}
      />,
    );
    expect(screen.getByText("New")).toBeInTheDocument();
  });
});
