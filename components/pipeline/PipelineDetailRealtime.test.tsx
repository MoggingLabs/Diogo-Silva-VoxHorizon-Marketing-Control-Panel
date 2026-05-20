/**
 * PipelineDetailRealtime is renderless — it subscribes (via the SSE relay
 * hook) to `pipelines` + `pipeline_events` for one id and calls
 * router.refresh() on any change. Tests verify the subscription specs +
 * handler dispatch.
 */
import { render, act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mockRealtimeStream } from "@/tests/unit/helpers/realtime-mock";

const routerRefresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: routerRefresh, push: vi.fn(), replace: vi.fn() }),
}));

const realtime = mockRealtimeStream();
vi.mock("@/hooks/useRealtimeStream", () => ({
  useRealtimeStream: (listeners: unknown) =>
    realtime.register(listeners as Parameters<typeof realtime.register>[0]),
}));

import { PipelineDetailRealtime } from "./PipelineDetailRealtime";

beforeEach(() => {
  routerRefresh.mockReset();
  realtime.reset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("PipelineDetailRealtime", () => {
  it("subscribes to pipelines + pipeline_events filtered by the id", () => {
    render(<PipelineDetailRealtime pipelineId="p1" />);
    const specs = realtime.listeners.map((l) => ({ table: l.table, filter: l.filter }));
    expect(specs).toEqual(
      expect.arrayContaining([
        { table: "pipelines", filter: "id=eq.p1" },
        { table: "pipeline_events", filter: "pipeline_id=eq.p1" },
      ]),
    );
  });

  it("registers listeners (the relay hook owns its own teardown)", () => {
    const { unmount } = render(<PipelineDetailRealtime pipelineId="p1" />);
    expect(realtime.spy).toHaveBeenCalled();
    expect(() => unmount()).not.toThrow();
  });

  it("router.refresh() fires when either subscribed table receives an event", () => {
    render(<PipelineDetailRealtime pipelineId="p1" />);
    act(() => {
      realtime.emit("pipelines", "UPDATE", { new: { id: "p1" } });
      realtime.emit("pipeline_events", "INSERT", { new: { id: "e1" } });
    });
    expect(routerRefresh).toHaveBeenCalledTimes(2);
  });

  it("renders nothing visible (renderless)", () => {
    const { container } = render(<PipelineDetailRealtime pipelineId="p1" />);
    expect(container.firstChild).toBeNull();
  });
});
