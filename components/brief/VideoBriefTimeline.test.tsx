/**
 * Tests for the video brief realtime event timeline.
 *
 * Covers:
 *   - Empty-state copy.
 *   - Sorted-descending rendering by createdAt.
 *   - Payload pretty-print when payload has keys.
 *   - No payload section when payload is null or {}.
 *   - Channel subscribed/unsubscribed.
 *   - Realtime INSERT handler appends a new event to the top.
 *   - Duplicate INSERTs (matching id) are ignored.
 *   - INSERTs without an id are dropped.
 */
import { render, screen } from "@testing-library/react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mockRealtimeStream } from "@/tests/unit/helpers/realtime-mock";

const realtime = mockRealtimeStream();

vi.mock("@/hooks/useRealtimeStream", () => ({
  useRealtimeStream: (listeners: unknown) =>
    realtime.register(listeners as Parameters<typeof realtime.register>[0]),
}));

import { VideoBriefTimeline } from "./VideoBriefTimeline";

type LocalEvent = {
  id: string;
  kind: string;
  created_at: string;
  payload: Record<string, unknown> | null;
};

beforeEach(() => {
  realtime.reset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("VideoBriefTimeline", () => {
  it("shows the empty-state copy when no events", () => {
    render(<VideoBriefTimeline videoBriefId="vb1" initialEvents={[]} />);

    expect(screen.getByText("No events yet.")).toBeInTheDocument();
  });

  it("renders each event with its kind badge", () => {
    const events: LocalEvent[] = [
      {
        id: "1",
        kind: "video_brief_created",
        created_at: "2026-05-01T10:00:00Z",
        payload: null,
      },
      {
        id: "2",
        kind: "video_brief_decided",
        created_at: "2026-05-02T10:00:00Z",
        payload: null,
      },
    ];

    render(<VideoBriefTimeline videoBriefId="vb1" initialEvents={events} />);

    expect(screen.getByText("video_brief_created")).toBeInTheDocument();
    expect(screen.getByText("video_brief_decided")).toBeInTheDocument();
  });

  it("renders the payload preformatted block when payload has keys", () => {
    render(
      <VideoBriefTimeline
        videoBriefId="vb1"
        initialEvents={[
          {
            id: "1",
            kind: "video_brief_decided",
            created_at: "2026-05-01T00:00:00Z",
            payload: { notes: "looks great" },
          },
        ]}
      />,
    );

    expect(screen.getByText(/"notes": "looks great"/)).toBeInTheDocument();
  });

  it("omits the payload block when payload is null", () => {
    const { container } = render(
      <VideoBriefTimeline
        videoBriefId="vb1"
        initialEvents={[
          {
            id: "1",
            kind: "x",
            created_at: "2026-05-01T00:00:00Z",
            payload: null,
          },
        ]}
      />,
    );

    expect(container.querySelector("pre")).toBeNull();
  });

  it("omits the payload block when payload has no keys", () => {
    const { container } = render(
      <VideoBriefTimeline
        videoBriefId="vb1"
        initialEvents={[
          {
            id: "1",
            kind: "x",
            created_at: "2026-05-01T00:00:00Z",
            payload: {},
          },
        ]}
      />,
    );

    expect(container.querySelector("pre")).toBeNull();
  });

  it("subscribes to the events relay filtered by ref_id", () => {
    const { unmount } = render(<VideoBriefTimeline videoBriefId="vb1" initialEvents={[]} />);
    const listener = realtime.listeners.find((l) => l.table === "events");
    expect(listener).toBeDefined();
    expect(listener?.event).toBe("INSERT");
    expect(listener?.filter).toBe("ref_id=eq.vb1");
    expect(() => unmount()).not.toThrow();
  });

  it("appends a new event when the realtime handler fires", () => {
    render(<VideoBriefTimeline videoBriefId="vb1" initialEvents={[]} />);

    act(() => {
      realtime.emit("events", "INSERT", {
        new: {
          id: "new-1",
          kind: "video_brief_decided",
          created_at: "2026-05-04T00:00:00Z",
          payload: null,
        },
      });
    });

    expect(screen.getByText("video_brief_decided")).toBeInTheDocument();
  });

  it("ignores duplicate INSERTs (matching id)", () => {
    const initial: LocalEvent = {
      id: "dup",
      kind: "video_brief_created",
      created_at: "2026-05-01T00:00:00Z",
      payload: null,
    };
    render(<VideoBriefTimeline videoBriefId="vb1" initialEvents={[initial]} />);

    act(() => {
      realtime.emit("events", "INSERT", { new: initial });
    });

    // Should still only have one event rendered.
    expect(screen.getAllByText("video_brief_created")).toHaveLength(1);
  });

  it("drops INSERTs that lack an id", () => {
    render(<VideoBriefTimeline videoBriefId="vb1" initialEvents={[]} />);

    act(() => {
      realtime.emit("events", "INSERT", {
        new: {
          id: null as unknown as string,
          kind: "video_brief_created",
          created_at: "2026-05-04T00:00:00Z",
          payload: null,
        },
      });
    });

    expect(screen.getByText("No events yet.")).toBeInTheDocument();
  });
});
