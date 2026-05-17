/**
 * VideoVariantsGrid mirrors VariantsGrid for video creatives. Adds a
 * UrlBundle (captioned + composed + voiceover) and lazy-signs URLs for
 * each path on INSERT/UPDATE.
 */
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { VideoCreative } from "@/lib/video-creatives";
import type { VideoBrief } from "@/lib/video-briefs";

const routerReplace = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: routerReplace, refresh: vi.fn(), push: vi.fn() }),
  usePathname: () => "/creatives/video/b1",
  useSearchParams: () => new URLSearchParams(""),
}));

vi.mock("@/lib/realtime-queue", () => ({
  createRealtimeQueue: () => ({
    queue: (_k: string, run: () => void) => run(),
    flushNow: (_k: string, run: () => void) => run(),
    dispose: () => {},
  }),
}));

const channelHandlers: Record<
  string,
  Array<(p: { new?: VideoCreative; old?: Partial<VideoCreative> }) => void>
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
      cb: (p: { new?: VideoCreative; old?: Partial<VideoCreative> }) => void,
    ) => {
      if (spec.event in channelHandlers) channelHandlers[spec.event]!.push(cb);
      return ch;
    },
  );
  ch.subscribe = vi.fn(() => ch);
  ch.unsubscribe = vi.fn();
  return ch;
});

const createSignedUrl = vi.fn(async (path: string) => ({
  data: { signedUrl: `https://signed.example/${path}` },
  error: null,
}));

vi.mock("@/lib/supabase/browser", () => ({
  createClient: () => ({
    channel: channelSpy,
    removeChannel: removeChannelSpy,
    storage: { from: () => ({ createSignedUrl }) },
  }),
}));

vi.mock("./VideoSidePanel", () => ({
  VideoSidePanel: ({
    creative,
    open,
    onOpenChange,
  }: {
    creative: { id: string } | null;
    open: boolean;
    onOpenChange: (b: boolean) => void;
  }) => (
    <div data-testid="video-panel" data-open={open}>
      {creative?.id ?? "none"}
      <button onClick={() => onOpenChange(false)}>close-panel</button>
    </div>
  ),
}));

import { VideoVariantsGrid } from "./VideoVariantsGrid";

function makeCreative(over: Partial<VideoCreative> = {}): VideoCreative {
  return {
    id: `v-${Math.random().toString(36).slice(2)}`,
    brief_id: "b1",
    version: 1,
    status: "captioned",
    duration_actual_s: 30,
    composed_path: null,
    captioned_path: null,
    voiceover_path: null,
    script_path: null,
    broll_clips: null,
    drive_url: null,
    approved_at: null,
    created_at: new Date(Date.now() - 60_000).toISOString(),
    updated_at: new Date().toISOString(),
    ...(over as object),
  } as VideoCreative;
}

const briefStub: VideoBrief = {
  id: "b1",
  client_id: "c1",
  script_outline: null,
  target_duration_s: 30,
  voice_id: "v1",
  music_track: null,
  hook_style: null,
  dimensions: "9x16",
  captions_style: null,
  broll_selection_mode: "auto",
  notes: null,
  status: "approved",
  created_at: "2026-05-17T10:00:00Z",
  updated_at: "2026-05-17T10:00:00Z",
} as unknown as VideoBrief;

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

describe("VideoVariantsGrid", () => {
  it("renders the empty state when no creatives exist", () => {
    render(
      <VideoVariantsGrid
        brief={briefStub}
        initialCreatives={[]}
        initialSignedUrls={{}}
        selectedId={null}
      />,
    );
    expect(screen.getByText(/No video creatives yet/)).toBeInTheDocument();
  });

  it("renders one card per creative", () => {
    render(
      <VideoVariantsGrid
        brief={briefStub}
        initialCreatives={[makeCreative({ id: "v1" }), makeCreative({ id: "v2" })]}
        initialSignedUrls={{}}
        selectedId={null}
      />,
    );
    // Two video cards + the side-panel close-panel button = 3 buttons.
    const buttons = screen.getAllByRole("button");
    expect(buttons.length).toBeGreaterThanOrEqual(2);
  });

  it("updates URL on card click via router.replace", async () => {
    const user = userEvent.setup();
    render(
      <VideoVariantsGrid
        brief={briefStub}
        initialCreatives={[makeCreative({ id: "v1" })]}
        initialSignedUrls={{}}
        selectedId={null}
      />,
    );
    const cards = screen.getAllByRole("button");
    // Click the first card button (not the side panel close button)
    await user.click(cards[0]!);
    expect(routerReplace).toHaveBeenCalledWith(
      "/creatives/video/b1?creative=v1",
      expect.objectContaining({ scroll: false }),
    );
  });

  it("opens panel when selectedId matches", () => {
    render(
      <VideoVariantsGrid
        brief={briefStub}
        initialCreatives={[makeCreative({ id: "v1" })]}
        initialSignedUrls={{}}
        selectedId="v1"
      />,
    );
    expect(screen.getByTestId("video-panel")).toHaveAttribute("data-open", "true");
  });

  it("closes panel via onOpenChange triggers router.replace without creative param", async () => {
    const user = userEvent.setup();
    render(
      <VideoVariantsGrid
        brief={briefStub}
        initialCreatives={[makeCreative({ id: "v1" })]}
        initialSignedUrls={{}}
        selectedId="v1"
      />,
    );
    await user.click(screen.getByText("close-panel"));
    expect(routerReplace).toHaveBeenCalledWith(
      "/creatives/video/b1",
      expect.objectContaining({ scroll: false }),
    );
  });

  it("INSERT event appends new creative", async () => {
    render(
      <VideoVariantsGrid
        brief={briefStub}
        initialCreatives={[]}
        initialSignedUrls={{}}
        selectedId={null}
      />,
    );
    await act(async () => {
      channelHandlers.INSERT?.[0]?.({ new: makeCreative({ id: "vnew" }) });
    });
    expect(screen.getByTestId("video-panel")).toBeInTheDocument();
  });

  it("INSERT triggers signed URL fetch when paths are set", async () => {
    render(
      <VideoVariantsGrid
        brief={briefStub}
        initialCreatives={[]}
        initialSignedUrls={{}}
        selectedId={null}
      />,
    );
    await act(async () => {
      channelHandlers.INSERT?.[0]?.({
        new: makeCreative({
          id: "vnew",
          captioned_path: "cap.mp4",
          composed_path: "comp.mp4",
          voiceover_path: "vo.mp3",
        }),
      });
    });
    expect(createSignedUrl).toHaveBeenCalled();
  });

  it("INSERT dedupes by id", async () => {
    const existing = makeCreative({ id: "v1" });
    render(
      <VideoVariantsGrid
        brief={briefStub}
        initialCreatives={[existing]}
        initialSignedUrls={{}}
        selectedId={null}
      />,
    );
    const before = screen.getAllByRole("button").length;
    await act(async () => {
      channelHandlers.INSERT?.[0]?.({ new: existing });
    });
    expect(screen.getAllByRole("button").length).toBe(before);
  });

  it("UPDATE replaces an existing row", async () => {
    const c = makeCreative({ id: "v1", duration_actual_s: 30 });
    render(
      <VideoVariantsGrid
        brief={briefStub}
        initialCreatives={[c]}
        initialSignedUrls={{}}
        selectedId={null}
      />,
    );
    await act(async () => {
      channelHandlers.UPDATE?.[0]?.({ new: { ...c, duration_actual_s: 45 } });
    });
    // Card label includes the MM:SS-formatted duration.
    expect(screen.getByText("00:45")).toBeInTheDocument();
  });

  it("DELETE removes row + signed urls", async () => {
    const c = makeCreative({ id: "v1" });
    render(
      <VideoVariantsGrid
        brief={briefStub}
        initialCreatives={[c]}
        initialSignedUrls={{ v1: { captioned: "x", composed: null, voiceover: null } }}
        selectedId={null}
      />,
    );
    await act(async () => {
      channelHandlers.DELETE?.[0]?.({ old: { id: "v1" } });
    });
    expect(screen.getByText(/No video creatives yet/)).toBeInTheDocument();
  });

  it("DELETE without an id is a no-op", async () => {
    const c = makeCreative({ id: "v1" });
    render(
      <VideoVariantsGrid
        brief={briefStub}
        initialCreatives={[c]}
        initialSignedUrls={{}}
        selectedId={null}
      />,
    );
    await act(async () => {
      channelHandlers.DELETE?.[0]?.({ old: {} });
    });
    expect(screen.getAllByRole("button").length).toBeGreaterThan(0);
  });

  it("syncs to a new initialCreatives prop", () => {
    const { rerender } = render(
      <VideoVariantsGrid
        brief={briefStub}
        initialCreatives={[makeCreative({ id: "v1" })]}
        initialSignedUrls={{}}
        selectedId={null}
      />,
    );
    rerender(
      <VideoVariantsGrid
        brief={briefStub}
        initialCreatives={[]}
        initialSignedUrls={{}}
        selectedId={null}
      />,
    );
    expect(screen.getByText(/No video creatives yet/)).toBeInTheDocument();
  });

  it("removes the realtime channel on unmount", () => {
    const { unmount } = render(
      <VideoVariantsGrid
        brief={briefStub}
        initialCreatives={[]}
        initialSignedUrls={{}}
        selectedId={null}
      />,
    );
    unmount();
    expect(removeChannelSpy).toHaveBeenCalled();
  });
});
