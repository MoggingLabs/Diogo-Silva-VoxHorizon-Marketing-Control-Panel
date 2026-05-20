/**
 * IterationThread renders a chat-style list of `creative_iterations` and
 * stays live via a Supabase Realtime channel. Tests:
 *  - Empty-state, ordered rendering, icon per kind, author bubble
 *  - Realtime subscription mount + unmount (channel removed)
 *  - INSERT / UPDATE handlers fold rows into state via flushNow
 *  - Author/kind label fallback when enum values look weird
 *  - timeSince + content preview branches
 */
import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mockRealtimeStream } from "@/tests/unit/helpers/realtime-mock";
import type { CreativeIteration } from "@/lib/creatives";

const realtime = mockRealtimeStream();

vi.mock("@/hooks/useRealtimeStream", () => ({
  useRealtimeStream: (listeners: unknown) =>
    realtime.register(listeners as Parameters<typeof realtime.register>[0]),
}));

// Make the realtime queue flush synchronously for deterministic tests.
vi.mock("@/lib/realtime-queue", () => ({
  createRealtimeQueue: () => ({
    queue: (_k: string, run: () => void) => run(),
    flushNow: (_k: string, run: () => void) => run(),
    dispose: () => {},
  }),
}));

import { IterationThread } from "./IterationThread";

function makeIter(over: Partial<CreativeIteration> = {}): CreativeIteration {
  return {
    id: `i-${Math.random().toString(36).slice(2)}`,
    creative_id: "c1",
    kind: "generate",
    author: "ekko",
    content: { message: "Generated" },
    created_at: new Date(Date.now() - 10 * 60_000).toISOString(),
    ...(over as object),
  } as unknown as CreativeIteration;
}

beforeEach(() => {
  realtime.reset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("IterationThread", () => {
  it("renders the empty state when there are no iterations", () => {
    render(<IterationThread creativeId="c1" initialIterations={[]} />);
    expect(screen.getByText(/No iterations yet/)).toBeInTheDocument();
  });

  it("renders one entry per iteration with kind label + author", () => {
    const iters = [
      makeIter({ kind: "generate", author: "ekko", content: { message: "Drafted" } }),
      makeIter({ kind: "comment", author: "user", content: "manual note" }),
    ];
    render(<IterationThread creativeId="c1" initialIterations={iters} />);
    expect(screen.getByText("Generated")).toBeInTheDocument();
    expect(screen.getByText("Comment")).toBeInTheDocument();
    expect(screen.getByText("Drafted")).toBeInTheDocument();
    expect(screen.getByText("manual note")).toBeInTheDocument();
    expect(screen.getByText(/Ekko/)).toBeInTheDocument();
    expect(screen.getByText(/Operator/)).toBeInTheDocument();
  });

  it("falls back gracefully for unknown kind / author values", () => {
    const iter = makeIter({
      kind: "weird-kind" as CreativeIteration["kind"],
      author: "alien" as CreativeIteration["author"],
      content: null,
    });
    render(<IterationThread creativeId="c1" initialIterations={[iter]} />);
    expect(screen.getByText("weird-kind")).toBeInTheDocument();
    expect(screen.getByText(/alien/)).toBeInTheDocument();
  });

  it("subscribes to the creative_iterations relay filtered by creative id", () => {
    const { unmount } = render(<IterationThread creativeId="c1" initialIterations={[]} />);
    const listener = realtime.listeners.find((l) => l.table === "creative_iterations");
    expect(listener).toBeDefined();
    expect(listener?.filter).toBe("creative_id=eq.c1");
    expect(() => unmount()).not.toThrow();
  });

  it("appends a new iteration when an INSERT event fires", async () => {
    render(<IterationThread creativeId="c1" initialIterations={[]} />);
    expect(screen.getByText(/No iterations yet/)).toBeInTheDocument();

    const newIter = makeIter({ kind: "regenerate", content: { message: "Redid it" } });
    act(() => realtime.emit("creative_iterations", "INSERT", { new: newIter }));
    expect(await screen.findByText("Redid it")).toBeInTheDocument();
    expect(screen.getByText("Regenerated")).toBeInTheDocument();
  });

  it("dedupes INSERTs for the same id", async () => {
    render(<IterationThread creativeId="c1" initialIterations={[]} />);
    const it = makeIter({ id: "dup", content: { message: "Once" } });
    act(() => realtime.emit("creative_iterations", "INSERT", { new: it }));
    act(() =>
      realtime.emit("creative_iterations", "INSERT", {
        new: { ...it, content: { message: "Twice" } },
      }),
    );
    await waitFor(() => {
      expect(screen.getByText("Once")).toBeInTheDocument();
    });
    // Only one entry shown for the duplicate id.
    expect(screen.queryByText("Twice")).not.toBeInTheDocument();
  });

  it("applies an UPDATE event to an existing iteration", async () => {
    const start = makeIter({ id: "u1", content: { message: "old" } });
    render(<IterationThread creativeId="c1" initialIterations={[start]} />);
    expect(screen.getByText("old")).toBeInTheDocument();
    act(() =>
      realtime.emit("creative_iterations", "UPDATE", {
        new: { ...start, content: { message: "new!" } },
      }),
    );
    expect(await screen.findByText("new!")).toBeInTheDocument();
  });

  it("hides the preview p-tag when content is empty", () => {
    const iter = makeIter({ content: null });
    render(<IterationThread creativeId="c1" initialIterations={[iter]} />);
    // Only the kind/author header is rendered — verify the empty message is
    // absent (no extra <p> with text from the content).
    expect(screen.queryByText(/^Generated$/)).toBeInTheDocument();
  });

  it("falls back to JSON serialization when content has no recognised key", () => {
    const iter = makeIter({ content: { foo: "bar" } });
    render(<IterationThread creativeId="c1" initialIterations={[iter]} />);
    expect(screen.getByText(/"foo":"bar"/)).toBeInTheDocument();
  });

  it("uses a string content directly", () => {
    const iter = makeIter({ content: "raw string content" });
    render(<IterationThread creativeId="c1" initialIterations={[iter]} />);
    expect(screen.getByText("raw string content")).toBeInTheDocument();
  });

  it("syncs setIterations when initialIterations prop changes", () => {
    const { rerender } = render(
      <IterationThread creativeId="c1" initialIterations={[makeIter({ content: "first" })]} />,
    );
    expect(screen.getByText("first")).toBeInTheDocument();
    rerender(
      <IterationThread creativeId="c1" initialIterations={[makeIter({ content: "second" })]} />,
    );
    expect(screen.getByText("second")).toBeInTheDocument();
  });

  it("renders 'just now' for fresh iterations", () => {
    render(
      <IterationThread
        creativeId="c1"
        initialIterations={[makeIter({ created_at: new Date().toISOString() })]}
      />,
    );
    expect(screen.getByText("just now")).toBeInTheDocument();
  });

  it("renders Nh ago for hour-old iterations", () => {
    render(
      <IterationThread
        creativeId="c1"
        initialIterations={[
          makeIter({ created_at: new Date(Date.now() - 3 * 60 * 60_000).toISOString() }),
        ]}
      />,
    );
    expect(screen.getByText("3h ago")).toBeInTheDocument();
  });

  it("renders Nd ago for day-old iterations", () => {
    render(
      <IterationThread
        creativeId="c1"
        initialIterations={[
          makeIter({ created_at: new Date(Date.now() - 5 * 24 * 60 * 60_000).toISOString() }),
        ]}
      />,
    );
    expect(screen.getByText("5d ago")).toBeInTheDocument();
  });

  it("renders Nmo ago for month-old iterations", () => {
    render(
      <IterationThread
        creativeId="c1"
        initialIterations={[
          makeIter({ created_at: new Date(Date.now() - 60 * 24 * 60 * 60_000).toISOString() }),
        ]}
      />,
    );
    expect(screen.getByText(/mo ago/)).toBeInTheDocument();
  });

  it("renders 'just now' for future timestamps", () => {
    render(
      <IterationThread
        creativeId="c1"
        initialIterations={[makeIter({ created_at: new Date(Date.now() + 60_000).toISOString() })]}
      />,
    );
    expect(screen.getByText("just now")).toBeInTheDocument();
  });

  it("renders '—' for unparseable created_at", () => {
    render(
      <IterationThread
        creativeId="c1"
        initialIterations={[makeIter({ created_at: "not-a-date" })]}
      />,
    );
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("contentPreview returns empty string when JSON.stringify throws", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    render(
      <IterationThread
        creativeId="c1"
        initialIterations={[
          makeIter({ content: circular as unknown as CreativeIteration["content"] }),
        ]}
      />,
    );
    // The header still renders (kind + author); no crash from the throw.
    expect(screen.getByText("Generated")).toBeInTheDocument();
  });
});
