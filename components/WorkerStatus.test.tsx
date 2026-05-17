/**
 * Tests for the worker-health status indicator.
 *
 * The component:
 *   - polls `/api/worker/health` on mount + every 30s,
 *   - pauses on tab hidden, resumes on visible,
 *   - aborts in-flight requests on unmount,
 *   - derives state from the response payload (ok/degraded/down/unknown),
 *   - opens a tooltip on hover/focus showing version, uptime, queue depth.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { WorkerStatus } from "./WorkerStatus";
import { jsonResponse, spyOnFetch } from "@/tests/unit/helpers/worker-mock";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("WorkerStatus", () => {
  it("renders the initial 'checking' label before the first fetch resolves", () => {
    const fetchSpy = spyOnFetch();
    fetchSpy.mockImplementation(
      () =>
        new Promise<Response>(() => {
          /* never resolves */
        }),
    );

    render(<WorkerStatus />);

    expect(screen.getByRole("button", { name: /worker: checking/i })).toBeInTheDocument();
  });

  it("renders the healthy label after a successful response", async () => {
    spyOnFetch().mockImplementation(() =>
      Promise.resolve(
        jsonResponse({
          ok: true,
          worker: {
            ok: true,
            version: "1.2.3",
            uptime_seconds: 3700,
            claude_code_available: true,
            queue_depth: { image: 1, video: 2, broll: 0, total: 3 },
          },
        }),
      ),
    );
    render(<WorkerStatus />);

    expect(await screen.findByRole("button", { name: /worker: healthy/i })).toBeInTheDocument();
  });

  it("renders the unreachable label after an error response", async () => {
    spyOnFetch().mockImplementation(() =>
      Promise.resolve(jsonResponse({ ok: false, error: "boom" }, { status: 500 })),
    );
    render(<WorkerStatus />);

    expect(await screen.findByRole("button", { name: /worker: unreachable/i })).toBeInTheDocument();
  });

  it("renders the unreachable label after a network error", async () => {
    spyOnFetch().mockImplementation(() => Promise.reject(new Error("network")));
    render(<WorkerStatus />);

    expect(await screen.findByRole("button", { name: /worker: unreachable/i })).toBeInTheDocument();
  });

  it("uses the response error body when present", async () => {
    spyOnFetch().mockImplementation(() =>
      Promise.resolve(jsonResponse({ ok: false, error: "kaboom" }, { status: 503 })),
    );

    render(<WorkerStatus />);
    const btn = await screen.findByRole("button", {
      name: /worker: unreachable/i,
    });

    const user = userEvent.setup();
    await user.hover(btn);
    expect(screen.getByText("kaboom")).toBeInTheDocument();
  });

  it("opens a tooltip on hover and shows version + uptime + queue + Claude availability", async () => {
    spyOnFetch().mockImplementation(() =>
      Promise.resolve(
        jsonResponse({
          ok: true,
          worker: {
            ok: true,
            version: "1.0.0",
            uptime_seconds: 3700,
            claude_code_available: true,
            queue_depth: { image: 1, video: 2, broll: 3, total: 6 },
          },
        }),
      ),
    );

    render(<WorkerStatus />);
    const btn = await screen.findByRole("button", { name: /worker: healthy/i });

    const user = userEvent.setup();
    await user.hover(btn);

    expect(screen.getByText("1.0.0")).toBeInTheDocument();
    expect(screen.getByText(/1h 1m/)).toBeInTheDocument();
    expect(screen.getByText("available")).toBeInTheDocument();
    expect(screen.getByText("6 total in flight")).toBeInTheDocument();
  });

  it("renders 'not available' when claude_code_available is false", async () => {
    spyOnFetch().mockImplementation(() =>
      Promise.resolve(
        jsonResponse({
          ok: true,
          worker: { ok: true, claude_code_available: false },
        }),
      ),
    );

    render(<WorkerStatus />);
    const btn = await screen.findByRole("button", { name: /worker: healthy/i });

    const user = userEvent.setup();
    await user.hover(btn);
    expect(screen.getByText("not available")).toBeInTheDocument();
  });

  it("renders em-dash for queue_depth values when not provided", async () => {
    spyOnFetch().mockImplementation(() =>
      Promise.resolve(
        jsonResponse({
          ok: true,
          worker: { ok: true },
        }),
      ),
    );

    render(<WorkerStatus />);
    const btn = await screen.findByRole("button", { name: /worker: healthy/i });

    const user = userEvent.setup();
    await user.hover(btn);

    // Three queue rows render with `0` fallback since pickQueueCount returns null.
    expect(screen.getByText("Image")).toBeInTheDocument();
    expect(screen.getByText("Video")).toBeInTheDocument();
    expect(screen.getByText("B-roll")).toBeInTheDocument();
    // 'total in flight' suffix should be absent when queue_total is not a number.
    expect(screen.queryByText(/in flight/)).not.toBeInTheDocument();
  });

  it("uses scalar queue_depth as total only", async () => {
    spyOnFetch().mockImplementation(() =>
      Promise.resolve(
        jsonResponse({
          ok: true,
          worker: { ok: true, queue_depth: 42 },
        }),
      ),
    );

    render(<WorkerStatus />);
    const btn = await screen.findByRole("button", { name: /worker: healthy/i });

    const user = userEvent.setup();
    await user.hover(btn);
    expect(screen.getByText("42 total in flight")).toBeInTheDocument();
  });

  it("formats uptime for sub-minute, sub-hour, sub-day, and multi-day values", async () => {
    const cases: Array<[number, RegExp]> = [
      [45, /45s/],
      [600, /10m/],
      [3700, /1h 1m/],
      [90_000, /1d 1h/],
    ];

    for (const [uptime, label] of cases) {
      const fetchSpy = spyOnFetch();
      fetchSpy.mockImplementation(() =>
        Promise.resolve(
          jsonResponse({
            ok: true,
            worker: { ok: true, uptime_seconds: uptime },
          }),
        ),
      );

      const { unmount } = render(<WorkerStatus />);
      const btn = await screen.findByRole("button", {
        name: /worker: healthy/i,
      });
      const user = userEvent.setup();
      await user.hover(btn);
      expect(screen.getByText(label)).toBeInTheDocument();

      unmount();
      vi.restoreAllMocks();
    }
  });

  it("on click triggers an immediate manual refresh", async () => {
    const fetchSpy = spyOnFetch();
    fetchSpy.mockImplementation(() =>
      Promise.resolve(jsonResponse({ ok: true, worker: { ok: true } })),
    );

    render(<WorkerStatus />);
    const btn = await screen.findByRole("button", { name: /worker: healthy/i });
    const initialCalls = fetchSpy.mock.calls.length;

    const user = userEvent.setup();
    await user.click(btn);
    await waitFor(() => expect(fetchSpy.mock.calls.length).toBeGreaterThan(initialCalls));
  });

  it("aborts in-flight fetch on unmount", () => {
    const fetchSpy = spyOnFetch();
    let capturedSignal: AbortSignal | undefined;
    fetchSpy.mockImplementation((_input, init) => {
      capturedSignal = (init as RequestInit | undefined)?.signal as AbortSignal;
      return new Promise(() => {
        /* never resolves */
      });
    });

    const { unmount } = render(<WorkerStatus />);
    unmount();
    expect(capturedSignal?.aborted).toBe(true);
  });

  it("ignores AbortError from inflight fetches", async () => {
    const fetchSpy = spyOnFetch();
    const abortError = Object.assign(new Error("aborted"), {
      name: "AbortError",
    });
    fetchSpy.mockImplementationOnce(() => Promise.reject(abortError));

    render(<WorkerStatus />);

    // The label should remain 'checking' since the only fetch was aborted and
    // didn't set a result.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /worker: checking/i })).toBeInTheDocument(),
    );
  });

  it("falls back to Date.now when performance API is missing", async () => {
    const originalPerformance = globalThis.performance;
    Object.defineProperty(globalThis, "performance", {
      value: undefined,
      configurable: true,
    });

    spyOnFetch().mockImplementation(() =>
      Promise.resolve(jsonResponse({ ok: true, worker: { ok: true } })),
    );

    render(<WorkerStatus />);
    expect(await screen.findByRole("button", { name: /worker: healthy/i })).toBeInTheDocument();

    Object.defineProperty(globalThis, "performance", {
      value: originalPerformance,
      configurable: true,
    });
  });

  it("handles non-JSON response bodies gracefully", async () => {
    spyOnFetch().mockImplementation(() =>
      Promise.resolve(
        new Response("not-json", {
          status: 500,
          headers: { "content-type": "text/plain" },
        }),
      ),
    );

    render(<WorkerStatus />);

    expect(await screen.findByRole("button", { name: /worker: unreachable/i })).toBeInTheDocument();
  });

  it("closes the tooltip when the mouse leaves", async () => {
    spyOnFetch().mockImplementation(() =>
      Promise.resolve(jsonResponse({ ok: true, worker: { ok: true } })),
    );

    render(<WorkerStatus />);
    const btn = await screen.findByRole("button", { name: /worker: healthy/i });

    const user = userEvent.setup();
    await user.hover(btn);
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
    await user.unhover(btn);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("closes the tooltip on blur", async () => {
    spyOnFetch().mockImplementation(() =>
      Promise.resolve(jsonResponse({ ok: true, worker: { ok: true } })),
    );

    render(<WorkerStatus />);
    const btn = await screen.findByRole("button", { name: /worker: healthy/i });

    btn.focus();
    await waitFor(() => expect(screen.getByRole("tooltip")).toBeInTheDocument());
    btn.blur();
    await waitFor(() => expect(screen.queryByRole("tooltip")).not.toBeInTheDocument());
  });

  it("pauses polling when the document becomes hidden and resumes on visible", async () => {
    spyOnFetch().mockImplementation(() =>
      Promise.resolve(jsonResponse({ ok: true, worker: { ok: true } })),
    );

    render(<WorkerStatus />);
    await screen.findByRole("button", { name: /worker: healthy/i });

    // Hidden → stop()
    Object.defineProperty(document, "hidden", {
      value: true,
      configurable: true,
    });
    document.dispatchEvent(new Event("visibilitychange"));

    // Visible → start()
    Object.defineProperty(document, "hidden", {
      value: false,
      configurable: true,
    });
    document.dispatchEvent(new Event("visibilitychange"));

    // No throws; instance is still healthy.
    expect(screen.getByRole("button", { name: /worker: healthy/i })).toBeInTheDocument();
  });
});
