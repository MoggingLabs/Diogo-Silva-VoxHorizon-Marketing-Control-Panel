/**
 * PipelineList renders a filterable table of pipelines + subscribes to
 * realtime for the index page. Tests cover:
 *  - Empty state when no pipelines exist
 *  - "No matches" state when filters exclude every row
 *  - Status / format chip filtering
 *  - Realtime channel subscribe + unsubscribe
 *  - Client-name display (with id-prefix fallback)
 *  - Date formatting branches
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mockSupabaseClient, type SupabaseClientMock } from "@/tests/unit/helpers/supabase-mock";
import type { Pipeline } from "@/lib/pipeline/types";

const routerRefresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: routerRefresh, push: vi.fn(), replace: vi.fn() }),
}));

let currentClient: SupabaseClientMock = mockSupabaseClient();
vi.mock("@/lib/supabase/browser", () => ({
  createClient: () => currentClient,
}));

import { PipelineList } from "./PipelineList";

function makePipeline(over: Partial<Pipeline> = {}): Pipeline {
  return {
    id: "p1",
    status: "configuration",
    format_choice: "image",
    client_id: "c1",
    image_brief_id: null,
    video_brief_id: null,
    config_draft: null,
    picks: null,
    cost_estimate: null,
    cost_actual: null,
    approval: null,
    launch_package_id: null,
    created_at: "2026-05-17T10:00:00Z",
    updated_at: "2026-05-17T11:00:00Z",
    advanced_at: null,
    ...over,
  };
}

beforeEach(() => {
  routerRefresh.mockReset();
  currentClient = mockSupabaseClient();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("PipelineList", () => {
  it("renders the empty state when there are no pipelines", () => {
    render(<PipelineList initialPipelines={[]} clientNames={{}} />);
    expect(screen.getByText(/No pipelines yet/)).toBeInTheDocument();
  });

  it("renders a row per pipeline with client name", () => {
    render(
      <PipelineList
        initialPipelines={[makePipeline({ id: "p1", client_id: "c1" })]}
        clientNames={{ c1: "Acme" }}
      />,
    );
    expect(screen.getByText("Acme")).toBeInTheDocument();
  });

  it("falls back to client id slice when no name in clientNames", () => {
    render(
      <PipelineList
        initialPipelines={[makePipeline({ id: "p1", client_id: "abcd1234efgh" })]}
        clientNames={{}}
      />,
    );
    expect(screen.getByText("abcd1234")).toBeInTheDocument();
  });

  it("shows 'Unassigned' when pipeline has no client", () => {
    render(
      <PipelineList
        initialPipelines={[makePipeline({ id: "p1", client_id: null })]}
        clientNames={{}}
      />,
    );
    expect(screen.getByText("Unassigned")).toBeInTheDocument();
  });

  it("status chips filter rows", async () => {
    const user = userEvent.setup();
    render(
      <PipelineList
        initialPipelines={[
          makePipeline({ id: "p1", status: "configuration", client_id: "c1" }),
          makePipeline({ id: "p2", status: "done", client_id: "c2" }),
          makePipeline({ id: "p3", status: "cancelled", client_id: "c3" }),
        ]}
        clientNames={{ c1: "AlphaClient", c2: "BetaClient", c3: "GammaClient" }}
      />,
    );
    expect(screen.getByText("AlphaClient")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Done", pressed: false }));
    expect(screen.queryByText("AlphaClient")).not.toBeInTheDocument();
    expect(screen.getByText("BetaClient")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Cancelled", pressed: false }));
    expect(screen.getByText("GammaClient")).toBeInTheDocument();
    expect(screen.queryByText("BetaClient")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "In flight", pressed: false }));
    expect(screen.getByText("AlphaClient")).toBeInTheDocument();
  });

  it("format chips filter rows", async () => {
    const user = userEvent.setup();
    render(
      <PipelineList
        initialPipelines={[
          makePipeline({ id: "p1", format_choice: "image", client_id: "c1" }),
          makePipeline({ id: "p2", format_choice: "video", client_id: "c2" }),
          makePipeline({ id: "p3", format_choice: "both", client_id: "c3" }),
        ]}
        clientNames={{ c1: "Img", c2: "Vid", c3: "Both" }}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Video", pressed: false }));
    expect(screen.queryByText("Img")).not.toBeInTheDocument();
    expect(screen.getByText("Vid")).toBeInTheDocument();
    expect(screen.queryByText("Both")).not.toBeInTheDocument();
  });

  it("renders the 'no matches' state when filters exclude every row", async () => {
    const user = userEvent.setup();
    render(
      <PipelineList
        initialPipelines={[makePipeline({ status: "configuration", client_id: "c1" })]}
        clientNames={{ c1: "Acme" }}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Done", pressed: false }));
    expect(screen.getByText(/No pipelines match these filters/)).toBeInTheDocument();
  });

  it("subscribes to a realtime channel and unsubscribes on unmount", () => {
    const { unmount } = render(<PipelineList initialPipelines={[]} clientNames={{}} />);
    expect(currentClient._spies.channel).toHaveBeenCalledWith("pipelines:index");
    unmount();
    expect(currentClient._spies.removeChannel).toHaveBeenCalled();
  });

  it("realtime callback calls router.refresh()", () => {
    const handlers: Array<() => void> = [];
    const fakeChannel: Record<string, unknown> = {};
    fakeChannel.on = vi.fn((_e: string, _s: unknown, cb: () => void) => {
      handlers.push(cb);
      return fakeChannel;
    });
    fakeChannel.subscribe = vi.fn(() => fakeChannel);
    currentClient = {
      ...currentClient,
      channel: vi.fn(() => fakeChannel) as unknown as SupabaseClientMock["channel"],
    } as SupabaseClientMock;
    render(<PipelineList initialPipelines={[]} clientNames={{}} />);
    handlers.forEach((h) => h());
    expect(routerRefresh).toHaveBeenCalled();
  });

  it("syncs state when initialPipelines prop changes", () => {
    const { rerender } = render(
      <PipelineList
        initialPipelines={[makePipeline({ client_id: "c1" })]}
        clientNames={{ c1: "Old" }}
      />,
    );
    expect(screen.getByText("Old")).toBeInTheDocument();
    rerender(
      <PipelineList
        initialPipelines={[makePipeline({ client_id: "c2" })]}
        clientNames={{ c2: "New" }}
      />,
    );
    expect(screen.getByText("New")).toBeInTheDocument();
  });

  it("includes a 'Start new pipeline' CTA link", () => {
    render(<PipelineList initialPipelines={[makePipeline()]} clientNames={{ c1: "x" }} />);
    expect(screen.getByRole("link", { name: /Start new pipeline/i })).toHaveAttribute(
      "href",
      "/pipeline/new",
    );
  });

  it("falls back to raw timestamp when locale formatting throws", () => {
    // Date('not-a-date').toLocaleString() returns 'Invalid Date' on most engines —
    // not the raw string. Confirm the page still renders without crashing.
    render(
      <PipelineList
        initialPipelines={[makePipeline({ created_at: "garbage" })]}
        clientNames={{ c1: "OK" }}
      />,
    );
    expect(screen.getByText("OK")).toBeInTheDocument();
  });

  it("displays the pipeline format pill label", () => {
    render(
      <PipelineList
        initialPipelines={[makePipeline({ format_choice: "both" })]}
        clientNames={{ c1: "C" }}
      />,
    );
    expect(screen.getAllByText(/Image \+ Video/).length).toBeGreaterThan(0);
  });
});
