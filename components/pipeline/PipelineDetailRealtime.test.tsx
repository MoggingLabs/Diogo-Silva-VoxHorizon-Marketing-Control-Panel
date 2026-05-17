/**
 * PipelineDetailRealtime is renderless — it subscribes to two channels
 * and calls router.refresh() on any change. Tests verify the subscribe
 * + unsubscribe + handler dispatch.
 */
import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mockSupabaseClient, type SupabaseClientMock } from "@/tests/unit/helpers/supabase-mock";

const routerRefresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: routerRefresh, push: vi.fn(), replace: vi.fn() }),
}));

let currentClient: SupabaseClientMock = mockSupabaseClient();
vi.mock("@/lib/supabase/browser", () => ({
  createClient: () => currentClient,
}));

import { PipelineDetailRealtime } from "./PipelineDetailRealtime";

beforeEach(() => {
  routerRefresh.mockReset();
  currentClient = mockSupabaseClient();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("PipelineDetailRealtime", () => {
  it("subscribes to a channel named pipeline:<id>", () => {
    render(<PipelineDetailRealtime pipelineId="p1" />);
    expect(currentClient._spies.channel).toHaveBeenCalledWith("pipeline:p1");
  });

  it("removes the channel on unmount", () => {
    const { unmount } = render(<PipelineDetailRealtime pipelineId="p1" />);
    unmount();
    expect(currentClient._spies.removeChannel).toHaveBeenCalled();
  });

  it("router.refresh() fires when either subscribed table receives an event", () => {
    const handlers: Array<() => void> = [];
    const fakeChannel: Record<string, unknown> = {};
    fakeChannel.on = vi.fn((_evt: string, _spec: unknown, cb: () => void) => {
      handlers.push(cb);
      return fakeChannel;
    });
    fakeChannel.subscribe = vi.fn(() => fakeChannel);
    currentClient = {
      ...currentClient,
      channel: vi.fn(() => fakeChannel) as unknown as SupabaseClientMock["channel"],
    } as SupabaseClientMock;
    render(<PipelineDetailRealtime pipelineId="p1" />);
    handlers.forEach((h) => h());
    expect(routerRefresh).toHaveBeenCalledTimes(handlers.length);
  });

  it("renders nothing visible (renderless)", () => {
    const { container } = render(<PipelineDetailRealtime pipelineId="p1" />);
    expect(container.firstChild).toBeNull();
  });
});
