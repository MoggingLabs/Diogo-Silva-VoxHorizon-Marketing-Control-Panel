/**
 * Tests for the launch package timeline.
 *
 * Covers:
 *   - Empty-state copy.
 *   - Sorted-ascending render by created_at.
 *   - Each event kind has a friendly label (image + video variants).
 *   - Falls back to raw kind for unmapped values.
 *   - Renders decision payload chip when present.
 *   - Renders notes when payload.notes is non-empty.
 *   - Realtime channel uses the table from props ("launch_packages" default; or video).
 *   - Realtime callback calls router.refresh().
 */
import { render, screen, act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mockRealtimeStream } from "@/tests/unit/helpers/realtime-mock";

const refresh = vi.fn();
const realtime = mockRealtimeStream();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}));

vi.mock("@/hooks/useRealtimeStream", () => ({
  useRealtimeStream: (listeners: unknown) =>
    realtime.register(listeners as Parameters<typeof realtime.register>[0]),
}));

import { LaunchTimeline } from "./LaunchTimeline";

/**
 * Local helper to build an event with `payload` typed wide enough to satisfy
 * the EventRow's `Json` field (which is a deep recursive union).
 */
type LocalEvent = {
  id: string;
  kind: string;
  created_at: string;
  payload: unknown;
};
type EventArr = Parameters<typeof LaunchTimeline>[0]["initialEvents"];
const ev = (events: LocalEvent[]) => events as unknown as EventArr;

beforeEach(() => {
  refresh.mockReset();
  realtime.reset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("LaunchTimeline", () => {
  it("renders the empty-state copy", () => {
    render(<LaunchTimeline launchId="L1" initialEvents={[]} />);
    expect(screen.getByText("No events yet.")).toBeInTheDocument();
  });

  it("renders events sorted asc by created_at", () => {
    const events: LocalEvent[] = [
      { id: "1", kind: "launch_package_posted", created_at: "2026-05-02T00:00:00Z", payload: null },
      {
        id: "2",
        kind: "launch_package_decided",
        created_at: "2026-05-01T00:00:00Z",
        payload: null,
      },
    ];

    render(<LaunchTimeline launchId="L1" initialEvents={ev(events)} />);

    const items = screen.getAllByRole("listitem");
    expect(items[0]!.textContent).toContain("Decision recorded");
    expect(items[1]!.textContent).toContain("Launch posted");
  });

  it("renders friendly labels for each known image kind", () => {
    const kinds = [
      ["launch_package_posted", "Launch posted"],
      ["launch_package_failed", "Pre-flight failed"],
      ["launch_package_decided", "Decision recorded"],
    ] as const;

    for (const [kind, label] of kinds) {
      const { unmount } = render(
        <LaunchTimeline
          launchId="L1"
          initialEvents={ev([
            { id: kind, kind, created_at: "2026-05-01T00:00:00Z", payload: null },
          ])}
        />,
      );
      expect(screen.getByText(label)).toBeInTheDocument();
      unmount();
    }
  });

  it("renders friendly labels for each known video kind", () => {
    const kinds = [
      ["video_launch_package_posted", "Launch posted"],
      ["video_launch_package_failed", "Pre-flight failed"],
      ["video_launch_package_decided", "Decision recorded"],
    ] as const;

    for (const [kind, label] of kinds) {
      const { unmount } = render(
        <LaunchTimeline
          launchId="L1"
          table="video_launch_packages"
          initialEvents={ev([
            { id: kind, kind, created_at: "2026-05-01T00:00:00Z", payload: null },
          ])}
        />,
      );
      expect(screen.getByText(label)).toBeInTheDocument();
      unmount();
    }
  });

  it("falls back to raw kind for unknown event kinds", () => {
    render(
      <LaunchTimeline
        launchId="L1"
        initialEvents={ev([
          { id: "1", kind: "exotic_kind", created_at: "2026-05-01T00:00:00Z", payload: null },
        ])}
      />,
    );
    expect(screen.getByText("exotic_kind")).toBeInTheDocument();
  });

  it("renders the decision chip when payload.decision is a string", () => {
    render(
      <LaunchTimeline
        launchId="L1"
        initialEvents={ev([
          {
            id: "1",
            kind: "launch_package_decided",
            created_at: "2026-05-01T00:00:00Z",
            payload: { decision: "approved", notes: "all good" },
          },
        ])}
      />,
    );

    expect(screen.getByText("approved")).toBeInTheDocument();
    expect(screen.getByText("all good")).toBeInTheDocument();
  });

  it("ignores empty / whitespace notes", () => {
    render(
      <LaunchTimeline
        launchId="L1"
        initialEvents={ev([
          {
            id: "1",
            kind: "launch_package_decided",
            created_at: "2026-05-01T00:00:00Z",
            payload: { decision: "approved", notes: "   " },
          },
        ])}
      />,
    );

    // Notes paragraph should not render.
    expect(screen.queryByText("   ")).not.toBeInTheDocument();
  });

  it("ignores non-object payload values", () => {
    render(
      <LaunchTimeline
        launchId="L1"
        initialEvents={ev([
          {
            id: "1",
            kind: "launch_package_posted",
            created_at: "2026-05-01T00:00:00Z",
            payload: "garbage",
          },
        ])}
      />,
    );

    expect(screen.getByText("Launch posted")).toBeInTheDocument();
  });

  it("subscribes to the launch_packages relay (default table) filtered by id", () => {
    const { unmount } = render(<LaunchTimeline launchId="L1" initialEvents={[]} />);

    const listener = realtime.listeners.find((l) => l.table === "launch_packages");
    expect(listener).toBeDefined();
    expect(listener?.event).toBe("UPDATE");
    expect(listener?.filter).toBe("id=eq.L1");
    expect(() => unmount()).not.toThrow();
  });

  it("subscribes to the video table when table=video_launch_packages", () => {
    render(<LaunchTimeline launchId="L1" table="video_launch_packages" initialEvents={[]} />);

    const listener = realtime.listeners.find((l) => l.table === "video_launch_packages");
    expect(listener).toBeDefined();
    expect(listener?.filter).toBe("id=eq.L1");
  });

  it("calls router.refresh() when realtime UPDATE fires", () => {
    render(<LaunchTimeline launchId="L1" initialEvents={[]} />);
    act(() => {
      realtime.emit("launch_packages", "UPDATE", { new: { id: "L1" } });
    });
    expect(refresh).toHaveBeenCalled();
  });

  it("syncs to new initialEvents passed in on rerender", () => {
    const { rerender } = render(<LaunchTimeline launchId="L1" initialEvents={[]} />);

    rerender(
      <LaunchTimeline
        launchId="L1"
        initialEvents={ev([
          {
            id: "1",
            kind: "launch_package_posted",
            created_at: "2026-05-01T00:00:00Z",
            payload: null,
          },
        ])}
      />,
    );

    expect(screen.getByText("Launch posted")).toBeInTheDocument();
  });
});
