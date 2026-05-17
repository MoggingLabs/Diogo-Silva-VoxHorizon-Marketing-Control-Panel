/**
 * VideoIterationThread mirrors IterationThread but speaks the
 * `video_iterations` schema. Tests focus on the parts that diverge:
 *  - The richer KIND_ICON / KIND_LABEL maps
 *  - The video-specific contentPreview branches (`paths`, `voice_id`,
 *    `theme`, arrays)
 *  - Realtime subscription mount + unmount targeting `video_iterations`
 */
import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mockSupabaseClient, type SupabaseClientMock } from "@/tests/unit/helpers/supabase-mock";
import type { VideoIteration } from "@/lib/video-creatives";

let currentClient: SupabaseClientMock = mockSupabaseClient();

vi.mock("@/lib/supabase/browser", () => ({
  createClient: () => currentClient,
}));

vi.mock("@/lib/realtime-queue", () => ({
  createRealtimeQueue: () => ({
    queue: (_k: string, run: () => void) => run(),
    flushNow: (_k: string, run: () => void) => run(),
    dispose: () => {},
  }),
}));

import { VideoIterationThread } from "./VideoIterationThread";

function makeIter(over: Partial<VideoIteration> = {}): VideoIteration {
  return {
    id: `vi-${Math.random().toString(36).slice(2)}`,
    creative_id: "c1",
    kind: "generate_script",
    author: "ekko",
    content: { message: "Generated" },
    created_at: new Date(Date.now() - 10 * 60_000).toISOString(),
    ...(over as object),
  } as unknown as VideoIteration;
}

beforeEach(() => {
  currentClient = mockSupabaseClient();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("VideoIterationThread", () => {
  it("renders the empty state when there are no iterations", () => {
    render(<VideoIterationThread creativeId="c1" initialIterations={[]} />);
    expect(screen.getByText(/No iterations yet/)).toBeInTheDocument();
  });

  it.each([
    ["generate_script", /Generated script/],
    ["regenerate_voiceover", /Regenerated voiceover/],
    ["search_broll", /Searched b-roll/],
    ["swap_broll", /Swapped b-roll/],
    ["rerender", /Re-rendered/],
    ["recaption", /Re-captioned/],
    ["comment", /Comment/],
    ["user_edit", /Edit/],
  ] as const)("uses the correct label for kind=%s", (kind, label) => {
    render(
      <VideoIterationThread
        creativeId="c1"
        initialIterations={[makeIter({ kind, content: null })]}
      />,
    );
    expect(screen.getByText(label)).toBeInTheDocument();
  });

  it("falls back to a kind string when not in the map", () => {
    render(
      <VideoIterationThread
        creativeId="c1"
        initialIterations={[makeIter({ kind: "mystery" as VideoIteration["kind"], content: null })]}
      />,
    );
    expect(screen.getByText("mystery")).toBeInTheDocument();
  });

  it("renders a preview when content has 'paths'", () => {
    render(
      <VideoIterationThread
        creativeId="c1"
        initialIterations={[
          makeIter({
            content: {
              paths: {
                composed_path: "a.mp4",
                captioned_path: "b.mp4",
                voiceover_path: null,
              },
            },
          }),
        ]}
      />,
    );
    expect(screen.getByText(/Updated: composed_path, captioned_path/)).toBeInTheDocument();
  });

  it("renders a voice_id preview", () => {
    render(
      <VideoIterationThread
        creativeId="c1"
        initialIterations={[makeIter({ content: { voice_id: "v1" } })]}
      />,
    );
    expect(screen.getByText("Voice: v1")).toBeInTheDocument();
  });

  it("renders a theme preview", () => {
    render(
      <VideoIterationThread
        creativeId="c1"
        initialIterations={[makeIter({ content: { theme: "skyline" } })]}
      />,
    );
    expect(screen.getByText("Theme: skyline")).toBeInTheDocument();
  });

  it("falls back to JSON for arbitrary array content", () => {
    render(
      <VideoIterationThread
        creativeId="c1"
        initialIterations={[makeIter({ content: ["x", "y"] })]}
      />,
    );
    expect(screen.getByText(/\["x","y"\]/)).toBeInTheDocument();
  });

  it("passes string content through unchanged", () => {
    render(
      <VideoIterationThread
        creativeId="c1"
        initialIterations={[makeIter({ content: "raw text" })]}
      />,
    );
    expect(screen.getByText("raw text")).toBeInTheDocument();
  });

  it("subscribes to a 'video-iterations:<id>' channel and cleans up", () => {
    const { unmount } = render(<VideoIterationThread creativeId="c1" initialIterations={[]} />);
    expect(currentClient._spies.channel).toHaveBeenCalledWith(
      expect.stringContaining("video-iterations:c1"),
    );
    unmount();
    expect(currentClient._spies.removeChannel).toHaveBeenCalled();
  });

  it("appends rows from realtime INSERT events", async () => {
    const handlers: Array<(p: { new: VideoIteration }) => void> = [];
    const fakeChannel: Record<string, unknown> = {};
    fakeChannel.on = vi.fn(
      (_e: string, spec: { event: string }, cb: (p: { new: VideoIteration }) => void) => {
        if (spec.event === "INSERT") handlers.push(cb);
        return fakeChannel;
      },
    );
    fakeChannel.subscribe = vi.fn(() => fakeChannel);
    currentClient = {
      ...currentClient,
      channel: vi.fn(() => fakeChannel) as unknown as SupabaseClientMock["channel"],
    } as SupabaseClientMock;

    render(<VideoIterationThread creativeId="c1" initialIterations={[]} />);
    act(() => handlers[0]?.({ new: makeIter({ content: { message: "fresh" } }) }));
    expect(await screen.findByText("fresh")).toBeInTheDocument();
  });

  it("UPDATE replaces the matching row", async () => {
    const handlers: Array<(p: { new: VideoIteration }) => void> = [];
    const fakeChannel: Record<string, unknown> = {};
    fakeChannel.on = vi.fn(
      (_e: string, spec: { event: string }, cb: (p: { new: VideoIteration }) => void) => {
        if (spec.event === "UPDATE") handlers.push(cb);
        return fakeChannel;
      },
    );
    fakeChannel.subscribe = vi.fn(() => fakeChannel);
    currentClient = {
      ...currentClient,
      channel: vi.fn(() => fakeChannel) as unknown as SupabaseClientMock["channel"],
    } as SupabaseClientMock;

    const start = makeIter({ id: "u1", content: { message: "old" } });
    render(<VideoIterationThread creativeId="c1" initialIterations={[start]} />);
    act(() => handlers[0]?.({ new: { ...start, content: { message: "new" } } }));
    await waitFor(() => expect(screen.getByText("new")).toBeInTheDocument());
  });

  it("syncs to a new initialIterations prop", () => {
    const { rerender } = render(
      <VideoIterationThread creativeId="c1" initialIterations={[makeIter({ content: "first" })]} />,
    );
    expect(screen.getByText("first")).toBeInTheDocument();
    rerender(
      <VideoIterationThread
        creativeId="c1"
        initialIterations={[makeIter({ content: "second" })]}
      />,
    );
    expect(screen.getByText("second")).toBeInTheDocument();
  });

  it("sorts iterations chronologically", () => {
    render(
      <VideoIterationThread
        creativeId="c1"
        initialIterations={[
          makeIter({ id: "late", content: "later", created_at: "2026-05-17T11:00:00Z" }),
          makeIter({ id: "early", content: "earlier", created_at: "2026-05-17T09:00:00Z" }),
        ]}
      />,
    );
    const previews = screen.getAllByText(/later|earlier/);
    // Older first; matches the oldest-first ordering.
    expect(previews[0]?.textContent).toContain("earlier");
  });

  it("falls back to JSON for object content with no recognised key", () => {
    render(
      <VideoIterationThread
        creativeId="c1"
        initialIterations={[makeIter({ content: { unknown_key: "foo" } })]}
      />,
    );
    expect(screen.getByText(/unknown_key/)).toBeInTheDocument();
  });

  it("returns empty when paths object has only null values", () => {
    render(
      <VideoIterationThread
        creativeId="c1"
        initialIterations={[
          makeIter({ content: { paths: { composed: null, captioned: undefined } } }),
        ]}
      />,
    );
    // No "Updated:" — preview falls through to JSON.
    expect(screen.queryByText(/Updated:/)).not.toBeInTheDocument();
  });

  it("survives circular content via try/catch", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    render(
      <VideoIterationThread
        creativeId="c1"
        initialIterations={[
          makeIter({ content: circular as unknown as ReturnType<typeof makeIter>["content"] }),
        ]}
      />,
    );
    // Header still renders.
    expect(screen.getByText(/Generated script/)).toBeInTheDocument();
  });

  it("survives a circular array content", () => {
    const arr: unknown[] = [];
    arr.push(arr);
    render(
      <VideoIterationThread
        creativeId="c1"
        initialIterations={[
          makeIter({ content: arr as unknown as ReturnType<typeof makeIter>["content"] }),
        ]}
      />,
    );
    expect(screen.getByText(/Generated script/)).toBeInTheDocument();
  });
});
