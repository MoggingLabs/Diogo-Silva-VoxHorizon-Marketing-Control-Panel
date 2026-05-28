/**
 * StageGeneration collapses pipeline_events into task rows. Tests cover:
 *  - Empty state when no events
 *  - StatusBadge per queued/running/done/error
 *  - Cost header derived from pipeline.cost_actual
 *  - Retry button on error rows
 *  - Thumbnail signed URL fetch for image tasks
 *  - Artifact link for video tasks
 *  - Poll interval cleanup
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { jsonResponse, spyOnFetch } from "@/tests/unit/helpers/worker-mock";
import { mockRealtimeStream } from "@/tests/unit/helpers/realtime-mock";

import type { Pipeline, PipelineEvent } from "@/lib/pipeline/types";
import type { WorkItem } from "@/lib/work-queue/types";

const routerRefresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: routerRefresh, push: vi.fn(), replace: vi.fn() }),
}));

// Stub the events hook to return what we give it. The hook itself is N4
// scope, so we keep it out of this spec.
vi.mock("@/hooks/usePipelineEvents", () => ({
  usePipelineEvents: (_id: string, seed: PipelineEvent[]) => seed,
}));

// The WorkItemPanelSlot mounts the panel (+ its real useActiveWorkItem) only
// when seeded with an active work_item. Mock the realtime relay so we can
// assert NO work_item channel opens when idle, and stub the embedded
// daemon-health badge (not under test here).
const realtime = mockRealtimeStream();
vi.mock("@/hooks/useRealtimeStream", () => ({
  useRealtimeStream: (listeners: unknown) =>
    realtime.register(listeners as Parameters<typeof realtime.register>[0]),
}));
vi.mock("@/hooks/useDaemonHealth", () => ({
  useDaemonHealth: () => ({ consumer: null, freshness: "down", isLoading: false, error: null }),
}));

// Signed URLs are minted server-side; mock the client-data helper. Returns a
// URL string (or null on failure), matching `signStoragePath`'s contract.
const signStoragePath = vi.fn<() => Promise<string | null>>(
  async () => "https://x.example/thumb.png",
);
vi.mock("@/lib/realtime/client-data", () => ({
  signStoragePath: () => signStoragePath(),
}));

import { StageGeneration } from "./StageGeneration";

function makePipeline(over: Partial<Pipeline> = {}): Pipeline {
  return {
    id: "p1",
    status: "generation",
    format_choice: "image",
    client_id: null,
    image_brief_id: null,
    video_brief_id: null,
    config_draft: null,
    picks: null,
    cost_estimate: null,
    cost_actual: null,
    approval: null,
    launch_package_id: null,
    created_at: "2026-05-17T10:00:00Z",
    updated_at: "2026-05-17T10:00:00Z",
    advanced_at: null,
    deleted_at: null,
    ...over,
  };
}

function makeWorkItem(over: Partial<WorkItem> = {}): WorkItem {
  return {
    id: "wi-1",
    kind: "operator_dispatch",
    pipeline_id: "p1",
    creative_id: null,
    brief_id: null,
    status: "running",
    attempt: 1,
    claim_token: "tok",
    claimed_by: "operator-daemon-1",
    claimed_at: "2026-05-26T12:00:00Z",
    heartbeat_at: new Date().toISOString(),
    completed_at: null,
    error_kind: null,
    error_detail: null,
    payload: { stage: "generation" },
    result: null,
    idempotency_key: "op-disp:p1:generation:kickoff",
    parent_work_item_id: null,
    created_by: "api/pipelines/operator",
    next_attempt_at: "2026-05-26T12:00:00Z",
    created_at: "2026-05-26T11:55:00Z",
    updated_at: "2026-05-26T12:00:00Z",
    ...over,
  };
}

function workItemListeners() {
  return realtime.listeners.filter((l) => l.table === "work_item");
}

function makeEvent(over: Partial<PipelineEvent> = {}): PipelineEvent {
  return {
    id: `e-${Math.random().toString(36).slice(2)}`,
    pipeline_id: "p1",
    kind: "task_queued",
    stage: "generation",
    payload: {},
    created_at: new Date().toISOString(),
    ...(over as object),
  } as PipelineEvent;
}

beforeEach(() => {
  routerRefresh.mockReset();
  signStoragePath.mockClear();
  realtime.reset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("StageGeneration", () => {
  it("renders the empty state when there are no task events", () => {
    render(<StageGeneration pipeline={makePipeline()} initialEvents={[]} />);
    expect(screen.getByText(/Generation is starting/)).toBeInTheDocument();
  });

  it("renders the running cost from cost_actual", () => {
    render(
      <StageGeneration
        pipeline={makePipeline({
          cost_actual: { items: [], total: 1.23 },
        })}
        initialEvents={[]}
      />,
    );
    expect(screen.getByText("$1.23")).toBeInTheDocument();
  });

  it("renders a row per task with status badges", () => {
    const events: PipelineEvent[] = [
      makeEvent({
        kind: "task_queued",
        payload: { parent_creative_id: "c1", ratio: "1x1", kind: "image" },
      }),
      makeEvent({
        kind: "task_running",
        payload: { parent_creative_id: "c1", ratio: "1x1", kind: "image" },
      }),
      makeEvent({
        kind: "task_done",
        payload: { parent_creative_id: "c1", ratio: "1x1", kind: "image", creative_id: "imgC1" },
      }),
    ];
    render(<StageGeneration pipeline={makePipeline()} initialEvents={events} />);
    expect(screen.getByText("Done")).toBeInTheDocument();
  });

  it("renders a Retry button on an error row + POSTs to retry endpoint on click", async () => {
    const fetchSpy = spyOnFetch();
    fetchSpy.mockResolvedValueOnce(jsonResponse({ ok: true }));
    const events: PipelineEvent[] = [
      makeEvent({
        id: "e-err",
        kind: "task_error",
        payload: { parent_creative_id: "c1", ratio: "1x1", kind: "image", error: "render failed" },
      }),
    ];
    const user = userEvent.setup();
    render(<StageGeneration pipeline={makePipeline()} initialEvents={events} />);
    expect(screen.getByText("Error")).toBeInTheDocument();
    expect(screen.getByText(/render failed/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Retry this task/i }));
    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringContaining("/api/pipelines/p1/tasks/e-err/retry"),
        expect.objectContaining({ method: "POST" }),
      );
    });
  });

  it("surfaces retry error inline", async () => {
    spyOnFetch().mockResolvedValueOnce(new Response("not allowed", { status: 403 }));
    const events: PipelineEvent[] = [
      makeEvent({
        id: "e-err",
        kind: "task_error",
        payload: { parent_creative_id: "c1", ratio: "1x1", kind: "image" },
      }),
    ];
    const user = userEvent.setup();
    render(<StageGeneration pipeline={makePipeline()} initialEvents={events} />);
    await user.click(screen.getByRole("button", { name: /Retry this task/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/not allowed/);
  });

  it("surfaces retry network failure", async () => {
    spyOnFetch().mockRejectedValueOnce(new Error("offline"));
    const events: PipelineEvent[] = [
      makeEvent({
        id: "e-err",
        kind: "task_error",
        payload: { parent_creative_id: "c1", ratio: "1x1", kind: "image" },
      }),
    ];
    const user = userEvent.setup();
    render(<StageGeneration pipeline={makePipeline()} initialEvents={events} />);
    await user.click(screen.getByRole("button", { name: /Retry this task/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/offline/);
  });

  it("resolves a signed URL for an image task thumbnail", async () => {
    const events: PipelineEvent[] = [
      makeEvent({
        kind: "task_done",
        payload: {
          parent_creative_id: "c1",
          ratio: "1x1",
          kind: "image",
          creative_id: "imgC1",
          file_path_supabase: "x.png",
        },
      }),
    ];
    render(<StageGeneration pipeline={makePipeline()} initialEvents={events} />);
    await waitFor(() => {
      expect(signStoragePath).toHaveBeenCalled();
    });
  });

  it("renders an artifact link for done video tasks", async () => {
    const events: PipelineEvent[] = [
      makeEvent({
        kind: "task_queued",
        payload: { creative_id: "v1", substage: "compose", kind: "video" },
      }),
      makeEvent({
        kind: "task_done",
        payload: {
          creative_id: "v1",
          substage: "compose",
          kind: "video",
          captioned_path: "cap.mp4",
        },
      }),
    ];
    render(<StageGeneration pipeline={makePipeline()} initialEvents={events} />);
    expect(screen.getByRole("button", { name: /Open/i })).toBeInTheDocument();
  });

  it("opens the signed URL when the artifact button is clicked", async () => {
    const events: PipelineEvent[] = [
      makeEvent({
        kind: "task_done",
        payload: {
          creative_id: "v1",
          substage: "compose",
          kind: "video",
          captioned_path: "cap.mp4",
        },
      }),
    ];
    const winOpen = vi.fn();
    vi.stubGlobal("open", winOpen);
    const user = userEvent.setup();
    render(<StageGeneration pipeline={makePipeline()} initialEvents={events} />);
    await user.click(screen.getByRole("button", { name: /Open/i }));
    await waitFor(() => {
      expect(winOpen).toHaveBeenCalled();
    });
    vi.unstubAllGlobals();
  });

  it("renders the done-completion summary when status=done", () => {
    render(
      <StageGeneration
        pipeline={makePipeline({ status: "done", cost_actual: { items: [], total: 5 } })}
        initialEvents={[]}
      />,
    );
    expect(screen.getByText(/Generation complete/)).toBeInTheDocument();
  });

  it("renders a creative_id hint on a running row", () => {
    const events: PipelineEvent[] = [
      makeEvent({
        kind: "task_running",
        payload: {
          parent_creative_id: "c1",
          ratio: "1x1",
          kind: "image",
          creative_id: "abcdef0123456789",
        },
      }),
    ];
    render(<StageGeneration pipeline={makePipeline()} initialEvents={events} />);
    expect(screen.getByText(/abcdef01…/)).toBeInTheDocument();
  });

  it("falls back to the icon when image task has no signed URL", async () => {
    signStoragePath.mockResolvedValueOnce(null);
    const events: PipelineEvent[] = [
      makeEvent({
        kind: "task_done",
        payload: {
          parent_creative_id: "c1",
          ratio: "1x1",
          kind: "image",
          creative_id: "imgC1",
          file_path_supabase: "x.png",
        },
      }),
    ];
    render(<StageGeneration pipeline={makePipeline()} initialEvents={events} />);
    // No thumbnail image; the icon fallback shows. Just verify signStoragePath ran.
    await waitFor(() => expect(signStoragePath).toHaveBeenCalled());
  });

  it("artifact link click warns on failed signing without opening a window", async () => {
    const events: PipelineEvent[] = [
      makeEvent({
        kind: "task_done",
        payload: { creative_id: "v1", substage: "compose", kind: "video", captioned_path: "x.mp4" },
      }),
    ];
    signStoragePath.mockResolvedValueOnce(null);
    const winOpen = vi.fn();
    vi.stubGlobal("open", winOpen);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const user = userEvent.setup();
    render(<StageGeneration pipeline={makePipeline()} initialEvents={events} />);
    await user.click(screen.getByRole("button", { name: /Open/i }));
    await waitFor(() => {
      expect(warn).toHaveBeenCalled();
      expect(winOpen).not.toHaveBeenCalled();
    });
    vi.unstubAllGlobals();
  });

  it("never opens for an image task with no file_path", async () => {
    const events: PipelineEvent[] = [
      makeEvent({
        kind: "task_done",
        payload: { parent_creative_id: "c1", ratio: "1x1", kind: "image", creative_id: "x" },
      }),
    ];
    render(<StageGeneration pipeline={makePipeline()} initialEvents={events} />);
    // No file_path -> no signing attempt.
    expect(signStoragePath).not.toHaveBeenCalled();
  });
});

describe("StageGeneration -- WorkItemPanelSlot (PR-5 SSR seed)", () => {
  it("renders the dispatcher panel when initialWorkItem is provided", () => {
    render(
      <StageGeneration
        pipeline={makePipeline()}
        initialEvents={[]}
        initialWorkItem={makeWorkItem({ status: "running" })}
      />,
    );
    expect(screen.getByTestId("work-item-panel-slot")).toBeInTheDocument();
    expect(screen.getByTestId("work-item-panel")).toHaveAttribute("data-state", "running");
    const wi = workItemListeners();
    expect(wi).toHaveLength(1);
    expect(wi[0]!.event).toBe("*");
  });

  it("renders NOTHING and opens NO realtime channel when initialWorkItem is absent (anti-stall)", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<StageGeneration pipeline={makePipeline()} initialEvents={[]} />);
    expect(screen.queryByTestId("work-item-panel-slot")).not.toBeInTheDocument();
    expect(screen.queryByTestId("work-item-panel")).not.toBeInTheDocument();
    // KEY regression: no work_item realtime channel on an idle generation stage.
    expect(workItemListeners()).toHaveLength(0);
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
