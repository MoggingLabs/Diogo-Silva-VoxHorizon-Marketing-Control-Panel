/**
 * Test helper for the server-side Realtime SSE relay hook
 * (`hooks/useRealtimeStream`).
 *
 * Component tests used to mock `@/lib/supabase/browser` and capture the
 * `.channel(...).on(handler)` callbacks. After Phase 2 of the RLS lockdown,
 * components subscribe via `useRealtimeStream(listeners)` instead. This helper
 * provides a drop-in mock that records the registered listeners and lets a
 * test fire a change event into them — the same "capture handlers, then invoke"
 * shape the old channel mock had.
 *
 * Usage:
 *
 *   import { mockRealtimeStream } from "@/tests/unit/helpers/realtime-mock";
 *
 *   const realtime = mockRealtimeStream();
 *   vi.mock("@/hooks/useRealtimeStream", () => ({
 *     useRealtimeStream: (listeners) => realtime.register(listeners),
 *   }));
 *
 *   // ...render the component...
 *   act(() => realtime.emit("creatives", "INSERT", { new: row }));
 */
import { vi } from "vitest";

export type CapturedListener = {
  table: string;
  event: "INSERT" | "UPDATE" | "DELETE" | "*";
  filter?: string;
  callback: (payload: { eventType?: string; new?: unknown; old?: unknown }) => void;
};

export type RealtimeStreamMock = {
  /** Stand-in for `useRealtimeStream` — pass it through `vi.mock`. */
  register: (listeners: CapturedListener[]) => void;
  /** Every listener registered across (re-)renders, in registration order. */
  listeners: CapturedListener[];
  /**
   * Fire a change to every matching listener (by table + event, honouring
   * `*`). `payload` is delivered as `{ eventType, new, old }`.
   */
  emit: (
    table: string,
    eventType: "INSERT" | "UPDATE" | "DELETE",
    payload: { new?: unknown; old?: unknown },
  ) => void;
  /** Spy so tests can assert the hook was invoked / how many listeners. */
  spy: ReturnType<typeof vi.fn>;
  /** Reset captured listeners between renders if a test needs a clean slate. */
  reset: () => void;
};

export function mockRealtimeStream(): RealtimeStreamMock {
  const listeners: CapturedListener[] = [];
  const spy = vi.fn();

  const register = (next: CapturedListener[]) => {
    spy(next);
    // Mirror the hook's behaviour: the latest render's listener set is the
    // active one. We append so a test can still inspect history, but `emit`
    // dispatches to all currently-registered matching listeners.
    for (const l of next) listeners.push(l);
  };

  const emit: RealtimeStreamMock["emit"] = (table, eventType, payload) => {
    for (const l of listeners) {
      if (l.table !== table) continue;
      if (l.event !== "*" && l.event !== eventType) continue;
      l.callback({
        eventType,
        new: payload.new ?? {},
        old: payload.old ?? {},
      });
    }
  };

  return {
    register,
    listeners,
    emit,
    spy,
    reset: () => {
      listeners.length = 0;
      spy.mockClear();
    },
  };
}
