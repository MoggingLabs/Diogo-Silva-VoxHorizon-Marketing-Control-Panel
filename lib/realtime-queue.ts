/**
 * Debounced Realtime invalidation queue.
 *
 * Realtime payloads can land in tight bursts — e.g. the worker writes
 * `creatives` + `creative_iterations` + `creative_iterations` again
 * inside one second. Each row triggers a Supabase Realtime callback;
 * if every callback synchronously fires `router.refresh()` or a state
 * update, React ends up re-running expensive server components several
 * times in a row.
 *
 * Pattern (forge `src/hooks/use-socket.ts:139-176`):
 *  - A module-level `Set<string>` of "pending keys"
 *  - A 200ms flush timer started lazily
 *  - When the timer fires, every queued key has its callback invoked
 *    once, then the set is cleared
 *  - Chat/streaming events bypass the queue — operators expect instant
 *    feedback while typing
 *
 * This module exposes `createRealtimeQueue()` which returns:
 *  - `queue(key, callback)`: schedule `callback` to run inside the next
 *    flush, deduped by `key`
 *  - `flushNow(key, callback)`: run synchronously; used for chat
 *  - `dispose()`: cancel the pending timer (for unmount)
 *
 * Per-component queues are cheap; each subscription owns one. We do not
 * share a singleton across the app because flush timing should reset
 * with the component lifecycle.
 */

export type RealtimeQueueCallback = () => void;

export type RealtimeQueue = {
  /** Queue a callback to run after the debounce window. Idempotent per key. */
  queue: (key: string, callback: RealtimeQueueCallback) => void;
  /** Run a callback immediately, outside the debounced batch. */
  flushNow: (key: string, callback: RealtimeQueueCallback) => void;
  /** Drop any pending callbacks and clear the timer (component unmount). */
  dispose: () => void;
};

export const DEFAULT_DEBOUNCE_MS = 200;

/**
 * Create a fresh debounce queue. The optional `delayMs` makes the
 * batching window tunable per call site; the default mirrors forge.
 *
 * Behaviour:
 *  - First `queue(...)` call starts a `setTimeout(delayMs)`
 *  - Subsequent calls within the window are deduped by key; later
 *    callbacks for the same key REPLACE earlier ones (so the latest
 *    closure wins — important when the caller captures fresh state)
 *  - On timer fire, every queued callback runs once; the queue resets
 *  - `flushNow` runs synchronously and does NOT cancel the pending
 *    timer (so a chat event can fire instantly while a separate
 *    background batch is still waiting)
 */
export function createRealtimeQueue(delayMs: number = DEFAULT_DEBOUNCE_MS): RealtimeQueue {
  const pending = new Map<string, RealtimeQueueCallback>();
  let timer: ReturnType<typeof setTimeout> | null = null;

  function flush(): void {
    timer = null;
    if (pending.size === 0) return;
    const snapshot = Array.from(pending.values());
    pending.clear();
    for (const cb of snapshot) {
      try {
        cb();
      } catch (e) {
        // Log + continue: one bad callback should not stall the rest.
        console.error("[realtime-queue] callback threw:", e);
      }
    }
  }

  return {
    queue(key, callback) {
      pending.set(key, callback);
      if (timer === null) {
        timer = setTimeout(flush, delayMs);
      }
    },
    flushNow(_key, callback) {
      try {
        callback();
      } catch (e) {
        console.error("[realtime-queue] flushNow callback threw:", e);
      }
    },
    dispose() {
      pending.clear();
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}
