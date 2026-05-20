/**
 * Tests for the SSE relay client hook. We stub `EventSource` with a
 * controllable fake so we can assert on the connection URL, event dispatch,
 * reconnect-with-backoff, and teardown.
 */
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseSubs } from "@/lib/realtime/topics";
import { useRealtimeStream, type RealtimeListener } from "./useRealtimeStream";

// ---- Fake EventSource -------------------------------------------------------
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  readyState = 0;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  private listeners: Record<string, Array<(e: MessageEvent) => void>> = {};
  closed = false;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, cb: (e: MessageEvent) => void) {
    (this.listeners[type] ||= []).push(cb);
  }
  close() {
    this.closed = true;
  }
  // Test helpers:
  emitMessage(data: string) {
    this.onmessage?.({ data } as MessageEvent);
  }
  emitNamed(type: string, data: string) {
    for (const cb of this.listeners[type] ?? []) cb({ data } as MessageEvent);
  }
  emitError() {
    this.onerror?.(new Event("error"));
  }
}

function Harness({ listeners, disabled }: { listeners: RealtimeListener[]; disabled?: boolean }) {
  useRealtimeStream(listeners, { disabled });
  return null;
}

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource as unknown as typeof EventSource);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("useRealtimeStream", () => {
  it("opens an EventSource with the encoded specs in the query", () => {
    render(
      <Harness
        listeners={[
          { table: "creatives", event: "INSERT", filter: "brief_id=eq.b1", callback: vi.fn() },
        ]}
      />,
    );
    expect(FakeEventSource.instances).toHaveLength(1);
    const src = FakeEventSource.instances[0]!;
    expect(src.url.startsWith("/api/realtime?subs=")).toBe(true);
    const encoded = src.url.split("subs=")[1]!;
    expect(parseSubs(encoded)).toEqual([
      { table: "creatives", event: "INSERT", filter: "brief_id=eq.b1" },
    ]);
  });

  it("does not connect when disabled", () => {
    render(<Harness disabled listeners={[{ table: "briefs", event: "*", callback: vi.fn() }]} />);
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it("does not connect with an empty listener set", () => {
    render(<Harness listeners={[]} />);
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it("dispatches a change to the matching listener (table + event)", () => {
    const onInsert = vi.fn();
    const onOther = vi.fn();
    render(
      <Harness
        listeners={[
          { table: "creatives", event: "INSERT", callback: onInsert },
          { table: "briefs", event: "UPDATE", callback: onOther },
        ]}
      />,
    );
    const src = FakeEventSource.instances[0]!;
    act(() => {
      src.emitMessage(
        JSON.stringify({ table: "creatives", eventType: "INSERT", new: { id: "c1" }, old: {} }),
      );
    });
    expect(onInsert).toHaveBeenCalledTimes(1);
    expect(onInsert.mock.calls[0]![0]).toEqual({ eventType: "INSERT", new: { id: "c1" }, old: {} });
    expect(onOther).not.toHaveBeenCalled();
  });

  it("delivers all event types to a `*` listener", () => {
    const onAny = vi.fn();
    render(<Harness listeners={[{ table: "pipelines", event: "*", callback: onAny }]} />);
    const src = FakeEventSource.instances[0]!;
    act(() => {
      src.emitMessage(
        JSON.stringify({ table: "pipelines", eventType: "DELETE", old: { id: "p" } }),
      );
    });
    expect(onAny).toHaveBeenCalledTimes(1);
  });

  it("ignores empty / malformed / shape-less messages", () => {
    const cb = vi.fn();
    render(<Harness listeners={[{ table: "creatives", event: "INSERT", callback: cb }]} />);
    const src = FakeEventSource.instances[0]!;
    act(() => {
      src.emitMessage("");
      src.emitMessage("not json");
      src.emitMessage(JSON.stringify({ nope: true }));
    });
    expect(cb).not.toHaveBeenCalled();
  });

  it("swallows a throwing listener so the stream survives", () => {
    const bad = vi.fn(() => {
      throw new Error("listener boom");
    });
    const good = vi.fn();
    render(
      <Harness
        listeners={[
          { table: "creatives", event: "INSERT", callback: bad },
          { table: "creatives", event: "INSERT", callback: good },
        ]}
      />,
    );
    const src = FakeEventSource.instances[0]!;
    expect(() =>
      act(() => src.emitMessage(JSON.stringify({ table: "creatives", eventType: "INSERT" }))),
    ).not.toThrow();
    expect(good).toHaveBeenCalled();
  });

  it("reconnects with backoff after an error, and the ready event resets it", () => {
    render(<Harness listeners={[{ table: "briefs", event: "*", callback: vi.fn() }]} />);
    expect(FakeEventSource.instances).toHaveLength(1);
    const first = FakeEventSource.instances[0]!;

    // First error → closes + schedules a reconnect after the base 1s backoff.
    act(() => first.emitError());
    expect(first.closed).toBe(true);
    act(() => vi.advanceTimersByTime(1_000));
    expect(FakeEventSource.instances).toHaveLength(2);

    // Second consecutive error escalates the delay to ~2s.
    const second = FakeEventSource.instances[1]!;
    act(() => second.emitError());
    act(() => vi.advanceTimersByTime(1_000)); // not yet
    expect(FakeEventSource.instances).toHaveLength(2);
    act(() => vi.advanceTimersByTime(1_000)); // now 2s elapsed
    expect(FakeEventSource.instances).toHaveLength(3);

    // A successful (re)subscribe resets the ladder back to the 1s base.
    const third = FakeEventSource.instances[2]!;
    act(() => third.emitNamed("ready", JSON.stringify({ count: 1 })));
    act(() => third.emitError());
    act(() => vi.advanceTimersByTime(1_000));
    expect(FakeEventSource.instances).toHaveLength(4);
  });

  it("closes the EventSource on unmount", () => {
    const { unmount } = render(
      <Harness listeners={[{ table: "briefs", event: "*", callback: vi.fn() }]} />,
    );
    const src = FakeEventSource.instances[0]!;
    unmount();
    expect(src.closed).toBe(true);
  });

  it("re-subscribes when the spec key changes (e.g. filter changes)", () => {
    const { rerender } = render(
      <Harness
        listeners={[
          { table: "creatives", event: "INSERT", filter: "brief_id=eq.b1", callback: vi.fn() },
        ]}
      />,
    );
    expect(FakeEventSource.instances).toHaveLength(1);
    rerender(
      <Harness
        listeners={[
          { table: "creatives", event: "INSERT", filter: "brief_id=eq.b2", callback: vi.fn() },
        ]}
      />,
    );
    // First connection closed; a new one opened for the new filter.
    expect(FakeEventSource.instances[0]!.closed).toBe(true);
    expect(FakeEventSource.instances).toHaveLength(2);
  });

  it("does NOT re-subscribe when only the callback identity changes", () => {
    const { rerender } = render(
      <Harness listeners={[{ table: "briefs", event: "*", callback: vi.fn() }]} />,
    );
    expect(FakeEventSource.instances).toHaveLength(1);
    rerender(<Harness listeners={[{ table: "briefs", event: "*", callback: vi.fn() }]} />);
    // Same spec → same single connection.
    expect(FakeEventSource.instances).toHaveLength(1);
  });
});
