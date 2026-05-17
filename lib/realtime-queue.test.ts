import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_DEBOUNCE_MS, createRealtimeQueue } from "./realtime-queue";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("createRealtimeQueue", () => {
  it("debounces queued callbacks by key after the default delay", () => {
    const queue = createRealtimeQueue();
    const cb1 = vi.fn();
    const cb2 = vi.fn();

    queue.queue("k1", cb1);
    queue.queue("k2", cb2);
    queue.queue("k1", cb1); // dedupe

    expect(cb1).not.toHaveBeenCalled();
    vi.advanceTimersByTime(DEFAULT_DEBOUNCE_MS);
    expect(cb1).toHaveBeenCalledTimes(1);
    expect(cb2).toHaveBeenCalledTimes(1);
  });

  it("uses the latest closure per key", () => {
    const queue = createRealtimeQueue(50);
    const first = vi.fn();
    const second = vi.fn();
    queue.queue("k", first);
    queue.queue("k", second); // replaces first
    vi.advanceTimersByTime(50);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalled();
  });

  it("flushNow runs immediately and outside the batch", () => {
    const queue = createRealtimeQueue();
    const cb = vi.fn();
    queue.flushNow("any", cb);
    expect(cb).toHaveBeenCalled();
  });

  it("logs but continues when a queued callback throws", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const queue = createRealtimeQueue(10);
    const bad = vi.fn(() => {
      throw new Error("oops");
    });
    const good = vi.fn();
    queue.queue("a", bad);
    queue.queue("b", good);
    vi.advanceTimersByTime(10);
    expect(bad).toHaveBeenCalled();
    expect(good).toHaveBeenCalled();
    expect(err).toHaveBeenCalled();
  });

  it("logs when a flushNow callback throws but does not rethrow", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const queue = createRealtimeQueue();
    expect(() =>
      queue.flushNow("k", () => {
        throw new Error("boom");
      }),
    ).not.toThrow();
    expect(err).toHaveBeenCalled();
  });

  it("dispose cancels pending callbacks", () => {
    const queue = createRealtimeQueue(20);
    const cb = vi.fn();
    queue.queue("k", cb);
    queue.dispose();
    vi.advanceTimersByTime(50);
    expect(cb).not.toHaveBeenCalled();
  });

  it("dispose is safe to call when nothing is pending", () => {
    const queue = createRealtimeQueue();
    expect(() => queue.dispose()).not.toThrow();
  });

  it("flushes nothing when the timer fires and the queue is empty", () => {
    const queue = createRealtimeQueue(15);
    const cb = vi.fn();
    queue.queue("k", cb);
    // Clear pending without disposing the timer; the flush should still
    // be safe.
    queue.dispose();
    queue.queue("k2", cb);
    vi.advanceTimersByTime(20);
    expect(cb).toHaveBeenCalledTimes(1);
  });
});
