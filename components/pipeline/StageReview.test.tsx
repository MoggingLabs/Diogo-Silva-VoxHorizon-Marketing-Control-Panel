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

import type { Pipeline } from "@/lib/pipeline/types";

const routerRefresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: routerRefresh, push: vi.fn(), replace: vi.fn() }),
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

// Silent-failure PR-3: the WorkItemPanelSlot auto-hides when nothing is queued.
let slotHasActiveWorkItem = false;
vi.mock("./WorkItemPanel", () => ({
  WorkItemPanelSlot: ({ pipelineId }: { pipelineId: string }) =>
    slotHasActiveWorkItem ? (
      <div data-testid="work-item-panel-slot" data-pipeline={pipelineId} />
    ) : null,
  WorkItemPanel: ({ pipelineId }: { pipelineId: string }) => (
    <div data-testid="work-item-panel" data-pipeline={pipelineId} />
  ),
}));

import { StageReview } from "./StageReview";

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
  slotHasActiveWorkItem = false;
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

describe("StageReview - work item panel slot (silent-failure PR-3)", () => {
  it("hides the WorkItemPanelSlot when no active work_item is in flight", () => {
    slotHasActiveWorkItem = false;
    render(<StageReview pipeline={makePipeline({ picks: { image: ["c1"] } })} />);
    expect(screen.queryByText(/hang tight/i)).not.toBeInTheDocument();
    expect(screen.queryByTestId("work-item-panel-slot")).not.toBeInTheDocument();
  });

  it("mounts the WorkItemPanelSlot when an active work_item is in flight", () => {
    slotHasActiveWorkItem = true;
    render(<StageReview pipeline={makePipeline({ picks: { image: ["c1"] } })} />);
    const slot = screen.getByTestId("work-item-panel-slot");
    expect(slot).toBeInTheDocument();
    expect(slot.getAttribute("data-pipeline")).toBe("p1");
  });
});
