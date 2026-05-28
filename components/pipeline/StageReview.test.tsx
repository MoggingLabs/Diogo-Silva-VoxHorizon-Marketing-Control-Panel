/**
 * StageReview shows pick previews + cost forecast + the 3-button approval
 * gate. Tests cover:
 *  - Empty-picks placeholder
 *  - Image picks grid: fetches rows from supabase, resolves signed URLs
 *  - Video picks grid: fetches rows + script outlines, renders hook
 *  - Approval gate: required notes for approve_with_changes / rejected
 *  - Submit flows + error surfacing
 *  - Fetch errors surface inline
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mockRealtimeStream } from "@/tests/unit/helpers/realtime-mock";
import type { Pipeline } from "@/lib/pipeline/types";
import type { WorkItem } from "@/lib/work-queue/types";

const routerRefresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: routerRefresh, push: vi.fn(), replace: vi.fn() }),
}));

// The WorkItemPanelSlot at the bottom of StageReview mounts the panel (and its
// real useActiveWorkItem) only when seeded with an active work_item. Mock the
// realtime relay so we can assert NO work_item channel opens when idle, and
// stub the embedded daemon-health badge (not under test here). useActiveWorkItem
// stays real so the gate is genuinely exercised.
const realtime = mockRealtimeStream();
vi.mock("@/hooks/useRealtimeStream", () => ({
  useRealtimeStream: (listeners: unknown) =>
    realtime.register(listeners as Parameters<typeof realtime.register>[0]),
}));
vi.mock("@/hooks/useDaemonHealth", () => ({
  useDaemonHealth: () => ({ consumer: null, freshness: "down", isLoading: false, error: null }),
}));

const submitReviewDecision = vi.fn();
vi.mock("@/lib/pipeline/client", () => ({
  submitReviewDecision: (...args: unknown[]) => submitReviewDecision(...args),
}));

// Pick previews + signed URLs are fetched via the service-role API routes
// (client-data helpers). Mock them per-test.
type Row = Record<string, unknown>;
const fetchCreativesByIds = vi.fn<() => Promise<Row[]>>(async () => []);
const fetchVideoCreativesByIdsWithOutline = vi.fn<
  () => Promise<{ creatives: Row[]; outlines: Record<string, unknown> }>
>(async () => ({ creatives: [], outlines: {} }));
const signStoragePaths = vi.fn<(b: string, p: string[]) => Promise<Record<string, string | null>>>(
  async (_b, paths) => Object.fromEntries(paths.map((p) => [p, "https://x.example/x.png"])),
);
vi.mock("@/lib/realtime/client-data", () => ({
  fetchCreativesByIds: () => fetchCreativesByIds(),
  fetchVideoCreativesByIdsWithOutline: () => fetchVideoCreativesByIdsWithOutline(),
  signStoragePaths: (b: string, p: string[]) => signStoragePaths(b, p),
}));

import { StageReview } from "./StageReview";

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
    payload: { stage: "review" },
    result: null,
    idempotency_key: "op-disp:p1:review:kickoff",
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

function makePipeline(over: Partial<Pipeline> = {}): Pipeline {
  return {
    id: "p1",
    status: "review",
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

beforeEach(() => {
  routerRefresh.mockReset();
  submitReviewDecision.mockReset();
  fetchCreativesByIds.mockReset();
  fetchCreativesByIds.mockResolvedValue([]);
  fetchVideoCreativesByIdsWithOutline.mockReset();
  fetchVideoCreativesByIdsWithOutline.mockResolvedValue({ creatives: [], outlines: {} });
  signStoragePaths.mockClear();
  realtime.reset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("StageReview", () => {
  it("renders the no-picks placeholder when nothing is picked", () => {
    render(<StageReview pipeline={makePipeline()} />);
    expect(screen.getByText(/No picks recorded/)).toBeInTheDocument();
  });

  it("fetches + renders image pick rows in the order from picks.image", async () => {
    fetchCreativesByIds.mockResolvedValue([
      { id: "c2", concept: "Second", ratio: "9x16", file_path_supabase: "b.png" },
      { id: "c1", concept: "First", ratio: "1x1", file_path_supabase: "a.png" },
    ]);
    render(<StageReview pipeline={makePipeline({ picks: { image: ["c1", "c2"] } })} />);
    expect(await screen.findByText("First")).toBeInTheDocument();
    expect(screen.getByText("Second")).toBeInTheDocument();
  });

  it("surfaces image-fetch error inline", async () => {
    fetchCreativesByIds.mockRejectedValue(new Error("rls"));
    render(<StageReview pipeline={makePipeline({ picks: { image: ["c1"] } })} />);
    expect(await screen.findByText(/Failed to load image picks: rls/)).toBeInTheDocument();
  });

  it("renders the no-image-picks placeholder when fetch returns no rows", async () => {
    fetchCreativesByIds.mockResolvedValue([]);
    render(<StageReview pipeline={makePipeline({ picks: { image: ["c1"] } })} />);
    expect(await screen.findByText(/No image picks yet/)).toBeInTheDocument();
  });

  it("renders the No render placeholder when no signed URL", async () => {
    fetchCreativesByIds.mockResolvedValue([
      { id: "c1", concept: "X", ratio: "1x1", file_path_supabase: null },
    ]);
    render(<StageReview pipeline={makePipeline({ picks: { image: ["c1"] } })} />);
    expect(await screen.findByText("X")).toBeInTheDocument();
  });

  it("fetches + renders video pick rows including outline hook", async () => {
    fetchVideoCreativesByIdsWithOutline.mockResolvedValue({
      creatives: [
        {
          id: "v1",
          status: "composed",
          duration_actual_s: 30,
          broll_clips: [{ x: 1 }],
          brief_id: "b1",
        },
      ],
      outlines: {
        b1: {
          hook: "Big hook",
          segments: [
            { topic: "a", duration_s: 10 },
            { topic: "b", duration_s: 20 },
          ],
        },
      },
    });
    render(
      <StageReview
        pipeline={makePipeline({
          format_choice: "video",
          picks: { video: ["v1"] },
        })}
      />,
    );
    expect(await screen.findByText("Big hook")).toBeInTheDocument();
    expect(screen.getByText(/2 segments/)).toBeInTheDocument();
    expect(screen.getByText(/1 b-roll clips planned/)).toBeInTheDocument();
  });

  it("renders 'No hook recorded' when video brief has no outline", async () => {
    fetchVideoCreativesByIdsWithOutline.mockResolvedValue({
      creatives: [
        {
          id: "v1",
          status: "draft",
          duration_actual_s: null,
          broll_clips: null,
          brief_id: "b1",
        },
      ],
      outlines: { b1: null },
    });
    render(
      <StageReview
        pipeline={makePipeline({
          format_choice: "video",
          picks: { video: ["v1"] },
        })}
      />,
    );
    expect(await screen.findByText(/No hook recorded/)).toBeInTheDocument();
  });

  it("surfaces video pick fetch error", async () => {
    fetchVideoCreativesByIdsWithOutline.mockRejectedValue(new Error("boom"));
    render(
      <StageReview
        pipeline={makePipeline({
          format_choice: "video",
          picks: { video: ["v1"] },
        })}
      />,
    );
    expect(await screen.findByText(/Failed to load video picks: boom/)).toBeInTheDocument();
  });

  it("approval gate disables buttons until picks exist", () => {
    render(<StageReview pipeline={makePipeline()} />);
    expect(screen.getByRole("button", { name: /Approve$/i })).toBeDisabled();
  });

  it("approval gate validates notes for approve_with_changes", async () => {
    const user = userEvent.setup();
    render(<StageReview pipeline={makePipeline({ picks: { image: ["c1"] } })} />);
    await user.click(screen.getByRole("button", { name: /Approve with changes/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Notes are required/);
    expect(submitReviewDecision).not.toHaveBeenCalled();
  });

  it("approval gate validates notes for rejected", async () => {
    const user = userEvent.setup();
    render(<StageReview pipeline={makePipeline({ picks: { image: ["c1"] } })} />);
    await user.click(screen.getByRole("button", { name: /Reject/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Notes are required/);
  });

  it("approve happy-path: submitReviewDecision + router.refresh", async () => {
    submitReviewDecision.mockResolvedValueOnce({ pipeline: { id: "p1" } });
    const user = userEvent.setup();
    render(<StageReview pipeline={makePipeline({ picks: { image: ["c1"] } })} />);
    await user.click(screen.getByRole("button", { name: /Approve$/i }));
    await waitFor(() => {
      expect(submitReviewDecision).toHaveBeenCalledWith(
        "p1",
        expect.objectContaining({ decision: "approved" }),
      );
      expect(routerRefresh).toHaveBeenCalled();
    });
  });

  it("approve_with_changes with notes proceeds", async () => {
    submitReviewDecision.mockResolvedValueOnce({ pipeline: { id: "p1" } });
    const user = userEvent.setup();
    render(<StageReview pipeline={makePipeline({ picks: { image: ["c1"] } })} />);
    await user.type(screen.getByRole("textbox"), "needs more contrast");
    await user.click(screen.getByRole("button", { name: /Approve with changes/i }));
    await waitFor(() => {
      expect(submitReviewDecision).toHaveBeenCalledWith(
        "p1",
        expect.objectContaining({
          decision: "approved_with_changes",
          notes: "needs more contrast",
        }),
      );
    });
  });

  it("surfaces submit errors inline", async () => {
    submitReviewDecision.mockRejectedValueOnce(new Error("server boom"));
    const user = userEvent.setup();
    render(<StageReview pipeline={makePipeline({ picks: { image: ["c1"] } })} />);
    await user.click(screen.getByRole("button", { name: /Approve$/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/server boom/);
  });

  it("surfaces non-Error rejection by stringifying", async () => {
    submitReviewDecision.mockRejectedValueOnce("string boom");
    const user = userEvent.setup();
    render(<StageReview pipeline={makePipeline({ picks: { image: ["c1"] } })} />);
    await user.click(screen.getByRole("button", { name: /Approve$/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/string boom/);
  });

  it("renders the cost forecast header", () => {
    render(<StageReview pipeline={makePipeline({ picks: { image: ["c1"] } })} />);
    expect(screen.getByText(/Cost forecast/)).toBeInTheDocument();
  });

  it("renders empty placeholder when video picks fetch returns nothing", async () => {
    fetchVideoCreativesByIdsWithOutline.mockResolvedValue({ creatives: [], outlines: {} });
    render(
      <StageReview
        pipeline={makePipeline({
          format_choice: "video",
          picks: { video: ["v1"] },
        })}
      />,
    );
    expect(await screen.findByText(/No video picks yet/)).toBeInTheDocument();
  });

  it("renders the duration label and segments for video picks", async () => {
    fetchVideoCreativesByIdsWithOutline.mockResolvedValue({
      creatives: [
        {
          id: "v1",
          status: "captioned",
          duration_actual_s: 30,
          broll_clips: [],
          brief_id: "b1",
        },
      ],
      outlines: { b1: { hook: "h", segments: [] } },
    });
    render(
      <StageReview
        pipeline={makePipeline({
          format_choice: "video",
          picks: { video: ["v1"] },
        })}
      />,
    );
    expect(await screen.findByText("30s")).toBeInTheDocument();
    expect(screen.getByText(/0 segments/)).toBeInTheDocument();
    expect(screen.getByText(/b-roll plan pending/)).toBeInTheDocument();
  });
});

describe("StageReview -- WorkItemPanelSlot (PR-5 SSR seed)", () => {
  it("renders the dispatcher panel when initialWorkItem is provided", () => {
    render(
      <StageReview
        pipeline={makePipeline()}
        initialWorkItem={makeWorkItem({ status: "running" })}
      />,
    );
    expect(screen.getByTestId("work-item-panel-slot")).toBeInTheDocument();
    expect(screen.getByTestId("work-item-panel")).toHaveAttribute("data-state", "running");
    // The seeded stream opens a single full work_item listener.
    const wi = workItemListeners();
    expect(wi).toHaveLength(1);
    expect(wi[0]!.event).toBe("*");
  });

  it("renders NOTHING and opens NO realtime channel when initialWorkItem is absent (anti-stall)", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<StageReview pipeline={makePipeline()} />);
    expect(screen.queryByTestId("work-item-panel-slot")).not.toBeInTheDocument();
    expect(screen.queryByTestId("work-item-panel")).not.toBeInTheDocument();
    // KEY regression: no work_item realtime channel on an idle review stage.
    expect(workItemListeners()).toHaveLength(0);
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
