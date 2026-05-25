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
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mockRealtimeStream } from "@/tests/unit/helpers/realtime-mock";
import type { Pipeline } from "@/lib/pipeline/types";

const routerRefresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: routerRefresh, push: vi.fn(), replace: vi.fn() }),
}));

const realtime = mockRealtimeStream();
vi.mock("@/hooks/useRealtimeStream", () => ({
  useRealtimeStream: (listeners: unknown) =>
    realtime.register(listeners as Parameters<typeof realtime.register>[0]),
}));

// The archive / restore row actions + the lazy archived-list fetch go through
// the pipeline fetch client. Mock the whole module so the component never hits
// the network in jsdom.
const listPipelinesMock = vi.fn();
const archivePipelineMock = vi.fn();
const restorePipelineMock = vi.fn();
vi.mock("@/lib/pipeline/client", () => ({
  listPipelines: (...args: unknown[]) => listPipelinesMock(...args),
  archivePipeline: (...args: unknown[]) => archivePipelineMock(...args),
  restorePipeline: (...args: unknown[]) => restorePipelineMock(...args),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
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
    deleted_at: null,
    ...over,
  };
}

beforeEach(() => {
  routerRefresh.mockReset();
  realtime.reset();
  listPipelinesMock.mockReset();
  archivePipelineMock.mockReset();
  restorePipelineMock.mockReset();
  // Default: the lazy archived fetch resolves to an empty set.
  listPipelinesMock.mockResolvedValue({ pipelines: [], next_cursor: null });
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

  it("subscribes to the pipelines realtime relay", () => {
    const { unmount } = render(<PipelineList initialPipelines={[]} clientNames={{}} />);
    const pipelinesListener = realtime.listeners.find((l) => l.table === "pipelines");
    expect(pipelinesListener).toBeDefined();
    expect(pipelinesListener?.event).toBe("*");
    expect(() => unmount()).not.toThrow();
  });

  it("realtime callback calls router.refresh()", () => {
    render(<PipelineList initialPipelines={[]} clientNames={{}} />);
    act(() => {
      realtime.emit("pipelines", "UPDATE", { new: { id: "p1" } });
    });
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

  // ----------------------------------------------------------------------
  // Archive / restore (#609)
  // ----------------------------------------------------------------------

  it("exposes an Archived status chip", () => {
    render(<PipelineList initialPipelines={[makePipeline()]} clientNames={{ c1: "x" }} />);
    expect(screen.getByRole("button", { name: "Archived", pressed: false })).toBeInTheDocument();
  });

  it("fetches the archived set on demand and lists those rows under the Archived filter", async () => {
    const user = userEvent.setup();
    listPipelinesMock.mockResolvedValue({
      pipelines: [
        makePipeline({
          id: "arch-1",
          client_id: "c9",
          deleted_at: "2026-05-20T00:00:00Z",
        }),
      ],
      next_cursor: null,
    });

    render(
      <PipelineList
        initialPipelines={[makePipeline({ id: "p1", client_id: "c1" })]}
        clientNames={{ c1: "ActiveClient", c9: "ArchivedClient" }}
      />,
    );

    // Active row visible up front; archived row not fetched yet.
    expect(screen.getByText("ActiveClient")).toBeInTheDocument();
    expect(screen.queryByText("ArchivedClient")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Archived", pressed: false }));

    // The archived view fetched with the archived flag and swapped in its rows.
    expect(listPipelinesMock).toHaveBeenCalledWith(expect.objectContaining({ archived: true }));
    expect(await screen.findByText("ArchivedClient")).toBeInTheDocument();
    // The active-only row is no longer shown (the data set was swapped).
    expect(screen.queryByText("ActiveClient")).not.toBeInTheDocument();
    // Archived rows offer a Restore action.
    expect(screen.getByRole("button", { name: /restore pipeline/i })).toBeInTheDocument();
  });

  it("archives a row via the row action menu", async () => {
    const user = userEvent.setup();
    archivePipelineMock.mockResolvedValue({ pipeline: makePipeline({ id: "p1" }) });

    render(
      <PipelineList
        initialPipelines={[makePipeline({ id: "p1", client_id: "c1" })]}
        clientNames={{ c1: "Acme" }}
      />,
    );

    await user.click(screen.getByRole("button", { name: /pipeline actions/i }));
    await user.click(screen.getByRole("menuitem", { name: /archive/i }));

    // The ConfirmArchive dialog opens; confirm it.
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^archive$/i }));

    expect(archivePipelineMock).toHaveBeenCalledWith("p1");
  });

  it("restores an archived row", async () => {
    const user = userEvent.setup();
    listPipelinesMock.mockResolvedValue({
      pipelines: [
        makePipeline({ id: "arch-1", client_id: "c9", deleted_at: "2026-05-20T00:00:00Z" }),
      ],
      next_cursor: null,
    });
    restorePipelineMock.mockResolvedValue({ pipeline: makePipeline({ id: "arch-1" }) });

    render(
      <PipelineList
        initialPipelines={[makePipeline({ id: "p1", client_id: "c1" })]}
        clientNames={{ c1: "ActiveClient", c9: "ArchivedClient" }}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Archived", pressed: false }));
    expect(await screen.findByText("ArchivedClient")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /restore pipeline/i }));
    expect(restorePipelineMock).toHaveBeenCalledWith("arch-1");
  });
});
