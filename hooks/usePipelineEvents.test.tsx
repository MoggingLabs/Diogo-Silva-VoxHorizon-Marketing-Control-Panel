/**
 * Tests for the `usePipelineEvents` hook (PF-E-3). Verifies:
 *  - initial events are stored chronological-first;
 *  - INSERT/UPDATE/DELETE realtime payloads flow through the debounce queue;
 *  - the queue is disposed on unmount (the SSE relay owns its teardown);
 *  - the hook re-seeds when the caller hands a fresh initialEvents prop.
 *
 * Realtime now flows through the server-side SSE relay hook, mocked via the
 * shared realtime-mock helper. The queue helper is mocked so we can drive it
 * synchronously without juggling fake timers.
 */
import { act, render } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PipelineEvent } from "@/lib/pipeline/types";
import { mockRealtimeStream } from "@/tests/unit/helpers/realtime-mock";

const realtime = mockRealtimeStream();
const queueImpl = {
  queue: vi.fn(),
  flushNow: vi.fn(),
  dispose: vi.fn(),
};

vi.mock("@/hooks/useRealtimeStream", () => ({
  useRealtimeStream: (listeners: unknown) =>
    realtime.register(listeners as Parameters<typeof realtime.register>[0]),
}));

vi.mock("@/lib/realtime-queue", () => ({
  createRealtimeQueue: () => queueImpl,
}));

import { usePipelineEvents } from "./usePipelineEvents";

beforeEach(() => {
  realtime.reset();
  queueImpl.queue.mockReset();
  queueImpl.flushNow.mockReset();
  queueImpl.dispose.mockReset();
  // The hook's debounce path calls `queue(key, cb)` and then we manually
  // invoke `cb()` to simulate the flush.
  queueImpl.queue.mockImplementation((_key: string, cb: () => void) => cb());
});

afterEach(() => {
  vi.clearAllMocks();
});

/**
 * Helper: render a tiny consumer that exposes the hook's output through
 * the DOM so we can assert on it. Returns the inner `<ul>` element.
 */
function Probe({ pipelineId, initial }: { pipelineId: string; initial: PipelineEvent[] }) {
  const events = usePipelineEvents(pipelineId, initial);
  return (
    <ul data-testid="events">
      {events.map((e) => (
        <li key={e.id} data-id={e.id} data-created={e.created_at}>
          {e.kind}
        </li>
      ))}
    </ul>
  );
}

function getIds(): string[] {
  return Array.from(document.querySelectorAll("[data-id]")).map(
    (el) => el.getAttribute("data-id") ?? "",
  );
}

function eventRow(over: Partial<PipelineEvent>): PipelineEvent {
  return {
    id: over.id ?? "e1",
    pipeline_id: "p1",
    kind: "stage_advanced",
    stage: null,
    payload: {},
    created_at: over.created_at ?? "2026-05-17T10:00:00Z",
    ...over,
  };
}

/**
 * Compatibility shim mirroring the old "capture .on handlers" helper. The
 * hook now registers listeners via the SSE relay hook; we expose
 * `handlers.INSERT/UPDATE/DELETE` that fan a payload into the matching
 * registered listeners on the `pipeline_events` table.
 */
function captureChannelHandlers() {
  const emitFor =
    (eventType: "INSERT" | "UPDATE" | "DELETE") => (payload: { new?: unknown; old?: unknown }) =>
      realtime.emit("pipeline_events", eventType, payload);
  const handlers: Record<
    "INSERT" | "UPDATE" | "DELETE",
    (p: { new?: unknown; old?: unknown }) => void
  > = {
    INSERT: emitFor("INSERT"),
    UPDATE: emitFor("UPDATE"),
    DELETE: emitFor("DELETE"),
  };
  return { handlers };
}

describe("usePipelineEvents", () => {
  it("returns the initial events sorted oldest-first", () => {
    const initial = [
      eventRow({ id: "later", created_at: "2026-05-17T11:00:00Z" }),
      eventRow({ id: "earlier", created_at: "2026-05-17T10:00:00Z" }),
    ];
    captureChannelHandlers();
    render(<Probe pipelineId="p1" initial={initial} />);
    expect(getIds()).toEqual(["earlier", "later"]);
  });

  it("ties broken by id when timestamps match", () => {
    const initial = [
      eventRow({ id: "b", created_at: "2026-05-17T10:00:00Z" }),
      eventRow({ id: "a", created_at: "2026-05-17T10:00:00Z" }),
    ];
    captureChannelHandlers();
    render(<Probe pipelineId="p1" initial={initial} />);
    expect(getIds()).toEqual(["a", "b"]);
  });

  it("appends an INSERT event and dedupes if it duplicates an existing one", () => {
    const initial = [eventRow({ id: "a", created_at: "2026-05-17T10:00:00Z" })];
    const { handlers } = captureChannelHandlers();
    render(<Probe pipelineId="p1" initial={initial} />);

    act(() => {
      handlers.INSERT?.({
        new: eventRow({ id: "b", created_at: "2026-05-17T11:00:00Z" }),
      });
    });
    expect(getIds()).toEqual(["a", "b"]);

    // Duplicate INSERT — the dedupe in the setState callback should drop it.
    act(() => {
      handlers.INSERT?.({
        new: eventRow({ id: "b", created_at: "2026-05-17T11:00:00Z" }),
      });
    });
    expect(getIds()).toEqual(["a", "b"]);
  });

  it("inserts an out-of-order event in the correct position", () => {
    const initial = [
      eventRow({ id: "a", created_at: "2026-05-17T10:00:00Z" }),
      eventRow({ id: "c", created_at: "2026-05-17T12:00:00Z" }),
    ];
    const { handlers } = captureChannelHandlers();
    render(<Probe pipelineId="p1" initial={initial} />);

    act(() => {
      handlers.INSERT?.({
        new: eventRow({ id: "b", created_at: "2026-05-17T11:00:00Z" }),
      });
    });
    expect(getIds()).toEqual(["a", "b", "c"]);
  });

  it("ignores INSERT payloads with no id", () => {
    captureChannelHandlers();
    render(<Probe pipelineId="p1" initial={[]} />);
    const { handlers } = captureChannelHandlers();
    // The first render captured the first set of handlers; trigger via the
    // last-known handler if available, otherwise fall through.
    if (handlers.INSERT) {
      act(() => handlers.INSERT?.({ new: { id: undefined } }));
    }
    expect(getIds()).toEqual([]);
  });

  it("updates an existing event on UPDATE", () => {
    const initial = [
      eventRow({ id: "a", kind: "stage_advanced", created_at: "2026-05-17T10:00:00Z" }),
    ];
    const { handlers } = captureChannelHandlers();
    render(<Probe pipelineId="p1" initial={initial} />);

    act(() => {
      handlers.UPDATE?.({
        new: eventRow({ id: "a", kind: "task_done", created_at: "2026-05-17T10:00:00Z" }),
      });
    });
    expect(document.querySelector("[data-id='a']")?.textContent).toBe("task_done");
  });

  it("treats UPDATE for an unknown id as an append", () => {
    const { handlers } = captureChannelHandlers();
    render(<Probe pipelineId="p1" initial={[]} />);

    act(() => {
      handlers.UPDATE?.({
        new: eventRow({ id: "x", created_at: "2026-05-17T10:00:00Z" }),
      });
    });
    expect(getIds()).toEqual(["x"]);
  });

  it("ignores UPDATE payloads with no id", () => {
    const { handlers } = captureChannelHandlers();
    render(<Probe pipelineId="p1" initial={[eventRow({ id: "a" })]} />);
    act(() => handlers.UPDATE?.({ new: { id: undefined } }));
    expect(getIds()).toEqual(["a"]);
  });

  it("removes an event on DELETE", () => {
    const initial = [
      eventRow({ id: "a" }),
      eventRow({ id: "b", created_at: "2026-05-17T11:00:00Z" }),
    ];
    const { handlers } = captureChannelHandlers();
    render(<Probe pipelineId="p1" initial={initial} />);

    act(() => handlers.DELETE?.({ old: { id: "a" } }));
    expect(getIds()).toEqual(["b"]);
  });

  it("ignores DELETE payloads with no id", () => {
    const { handlers } = captureChannelHandlers();
    render(<Probe pipelineId="p1" initial={[eventRow({ id: "a" })]} />);
    act(() => handlers.DELETE?.({ old: undefined }));
    expect(getIds()).toEqual(["a"]);
  });

  it("disposes the queue on unmount", () => {
    captureChannelHandlers();
    const { unmount } = render(<Probe pipelineId="p1" initial={[]} />);
    unmount();
    expect(queueImpl.dispose).toHaveBeenCalled();
  });

  it("does not subscribe when pipelineId is empty", () => {
    captureChannelHandlers();
    render(<Probe pipelineId="" initial={[]} />);
    // With an empty pipelineId the hook registers an empty listener set.
    const pipelineListeners = realtime.listeners.filter((l) => l.table === "pipeline_events");
    expect(pipelineListeners.length).toBe(0);
  });

  it("re-seeds when a new initialEvents prop arrives", () => {
    captureChannelHandlers();
    const { rerender } = render(<Probe pipelineId="p1" initial={[eventRow({ id: "a" })]} />);
    rerender(<Probe pipelineId="p1" initial={[eventRow({ id: "b" })]} />);
    expect(getIds()).toEqual(["b"]);
  });
});
