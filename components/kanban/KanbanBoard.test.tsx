/**
 * Tests for the two-track Kanban board.
 *
 * The board subscribes to Supabase Realtime and calls `router.refresh()`
 * when briefs or video_briefs change. We mock `next/navigation`,
 * `@/lib/supabase/browser`, and `@/lib/realtime-queue` so we can exercise
 * the effect end-to-end in jsdom.
 *
 * Covered:
 *   - Renders only the image track when format=image.
 *   - Renders only the video track when format=video.
 *   - Renders both tracks for format=both.
 *   - Renders the EmptyState when a track has no briefs.
 *   - Filters briefs to the "in_brief" column statuses.
 *   - Forwards pipelineId from the map to each KanbanCard.
 *   - Unsubscribes on unmount.
 */
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mockSupabaseClient, type SupabaseClientMock } from "@/tests/unit/helpers/supabase-mock";
import type { DashboardImageBrief, DashboardVideoBrief } from "@/lib/dashboard-types";

const refresh = vi.fn();
const queueSpy = vi.fn();
const disposeSpy = vi.fn();
let currentSupabase: SupabaseClientMock = mockSupabaseClient();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  useSearchParams: () => ({ toString: () => "" }),
}));

vi.mock("@/lib/supabase/browser", () => ({
  createClient: () => currentSupabase,
}));

vi.mock("@/lib/realtime-queue", () => ({
  createRealtimeQueue: () => ({
    queue: queueSpy,
    dispose: disposeSpy,
  }),
}));

import { KanbanBoard } from "./KanbanBoard";

function img(over: Partial<DashboardImageBrief> = {}): DashboardImageBrief {
  return {
    id: "ib-1",
    brief_id_human: "BRF-001",
    status: "draft",
    created_at: "2026-05-17T10:00:00Z",
    posted_at: null,
    decided_at: null,
    client: { id: "c1", slug: "acme", name: "Acme" },
    ...over,
  };
}

function vid(over: Partial<DashboardVideoBrief> = {}): DashboardVideoBrief {
  return {
    id: "vb-1",
    brief_id_human: "VBR-001",
    status: "draft",
    created_at: "2026-05-17T10:00:00Z",
    posted_at: null,
    decided_at: null,
    client: { id: "c1", slug: "acme", name: "Acme" },
    ...over,
  };
}

beforeEach(() => {
  refresh.mockReset();
  queueSpy.mockReset();
  disposeSpy.mockReset();
  currentSupabase = mockSupabaseClient();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("KanbanBoard", () => {
  it("renders only the image track when format=image", () => {
    render(<KanbanBoard format="image" imageBriefs={[img()]} videoBriefs={[vid()]} />);

    expect(screen.getByText("Image briefs")).toBeInTheDocument();
    expect(screen.queryByText("Video briefs")).not.toBeInTheDocument();
  });

  it("renders only the video track when format=video", () => {
    render(<KanbanBoard format="video" imageBriefs={[img()]} videoBriefs={[vid()]} />);

    expect(screen.queryByText("Image briefs")).not.toBeInTheDocument();
    expect(screen.getByText("Video briefs")).toBeInTheDocument();
  });

  it("renders both tracks when format=both", () => {
    render(<KanbanBoard format="both" imageBriefs={[img()]} videoBriefs={[vid()]} />);

    expect(screen.getByText("Image briefs")).toBeInTheDocument();
    expect(screen.getByText("Video briefs")).toBeInTheDocument();
  });

  it("renders the EmptyState when an image track has no briefs", () => {
    render(<KanbanBoard format="image" imageBriefs={[]} videoBriefs={[]} />);

    expect(screen.getByText("No active image briefs")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /New image brief/i })).toBeInTheDocument();
  });

  it("renders the EmptyState when a video track has no briefs", () => {
    render(<KanbanBoard format="video" imageBriefs={[]} videoBriefs={[]} />);

    expect(screen.getByText("No active video briefs")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /New video brief/i })).toBeInTheDocument();
  });

  it("filters briefs into the in_brief column by status", () => {
    const briefs = [
      img({ id: "b1", brief_id_human: "BRF-001", status: "draft" }),
      img({ id: "b2", brief_id_human: "BRF-002", status: "approved" }),
      img({ id: "b3", brief_id_human: "BRF-003", status: "rejected" }),
    ];
    render(<KanbanBoard format="image" imageBriefs={briefs} videoBriefs={[]} />);

    // Only draft + approved should land in the "in_brief" column.
    expect(screen.getByText("BRF-001")).toBeInTheDocument();
    expect(screen.getByText("BRF-002")).toBeInTheDocument();
    // rejected is filtered out (not in BRIEF_COLUMN_STATUSES)
    expect(screen.queryByText("BRF-003")).not.toBeInTheDocument();
  });

  it("uses pipelineId from imagePipelineMap when constructing card link", () => {
    render(
      <KanbanBoard
        format="image"
        imageBriefs={[img({ id: "ib-1" })]}
        videoBriefs={[]}
        imagePipelineMap={{ "ib-1": "pipe-99" }}
      />,
    );

    expect(screen.getByRole("link", { name: /BRF-001/ })).toHaveAttribute(
      "href",
      "/pipeline/pipe-99",
    );
  });

  it("uses pipelineId from videoPipelineMap when constructing video card link", () => {
    render(
      <KanbanBoard
        format="video"
        imageBriefs={[]}
        videoBriefs={[vid({ id: "vb-1" })]}
        videoPipelineMap={{ "vb-1": "pipe-77" }}
      />,
    );

    expect(screen.getByRole("link", { name: /VBR-001/ })).toHaveAttribute(
      "href",
      "/pipeline/pipe-77",
    );
  });

  it("sets up a realtime channel and calls dispose on unmount", () => {
    const { unmount } = render(<KanbanBoard format="both" imageBriefs={[]} videoBriefs={[]} />);

    expect(currentSupabase._spies.channel).toHaveBeenCalled();
    expect(disposeSpy).not.toHaveBeenCalled();
    unmount();
    expect(disposeSpy).toHaveBeenCalled();
    expect(currentSupabase._spies.removeChannel).toHaveBeenCalled();
  });

  it("queues briefs and video_briefs handlers to drive router.refresh()", () => {
    render(<KanbanBoard format="both" imageBriefs={[]} videoBriefs={[]} />);

    // Inspect the channel handlers configured against the mock.
    const channel = currentSupabase._spies.channel.mock.results[0]!.value as {
      on: ReturnType<typeof vi.fn>;
    };
    expect(channel.on).toHaveBeenCalledWith(
      "postgres_changes",
      { event: "*", schema: "public", table: "briefs" },
      expect.any(Function),
    );
    expect(channel.on).toHaveBeenCalledWith(
      "postgres_changes",
      { event: "*", schema: "public", table: "video_briefs" },
      expect.any(Function),
    );

    // Invoke the briefs handler — it should call queue with the labelled topic.
    const briefsCall = channel.on.mock.calls.find(
      (call) => (call[1] as { table: string }).table === "briefs",
    )!;
    const handler = briefsCall[2] as () => void;
    handler();
    expect(queueSpy).toHaveBeenCalledWith("briefs", expect.any(Function));

    // The provided callback should trigger router.refresh() when invoked.
    const queuedCb = queueSpy.mock.calls[0]![1] as () => void;
    queuedCb();
    expect(refresh).toHaveBeenCalled();
  });
});
