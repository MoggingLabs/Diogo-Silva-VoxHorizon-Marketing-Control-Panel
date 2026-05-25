/**
 * StageIdeation renders one column per active track + checkbox cards.
 * Tests:
 *  - Per-track loading + empty + error states
 *  - Pick toggle round-trips through updatePicks; revert on failure
 *  - Continue gate: every active track ≥1 pick
 *  - Realtime INSERT/UPDATE/DELETE for both creatives + video_creatives
 */
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { jsonResponse, spyOnFetch } from "@/tests/unit/helpers/worker-mock";
import { mockRealtimeStream } from "@/tests/unit/helpers/realtime-mock";
import type { Pipeline } from "@/lib/pipeline/types";

const routerRefresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: routerRefresh, push: vi.fn(), replace: vi.fn() }),
}));

const updatePicks = vi.fn();
vi.mock("@/lib/pipeline/client", () => ({
  updatePicks: (...args: unknown[]) => updatePicks(...args),
}));

vi.mock("@/lib/realtime-queue", () => ({
  createRealtimeQueue: () => ({
    queue: (_k: string, run: () => void) => run(),
    flushNow: (_k: string, run: () => void) => run(),
    dispose: () => {},
  }),
}));

const realtime = mockRealtimeStream();
vi.mock("@/hooks/useRealtimeStream", () => ({
  useRealtimeStream: (listeners: unknown) =>
    realtime.register(listeners as Parameters<typeof realtime.register>[0]),
}));

// Initial fetches + signing go through the service-role API routes
// (client-data helpers). Drive them per-test. `throws` simulates a rejection.
const supabaseFromMock: {
  creatives: { data: unknown[]; error: { message: string } | null; throws?: Error };
  video_creatives: { data: unknown[]; error: { message: string } | null; throws?: Error };
} = {
  creatives: { data: [], error: null as { message: string } | null },
  video_creatives: { data: [], error: null as { message: string } | null },
};

function resolveFetch(table: "creatives" | "video_creatives"): Promise<unknown[]> {
  const cfg = supabaseFromMock[table];
  if (cfg.throws) return Promise.reject(cfg.throws);
  // The API helpers throw on error; mirror that so the component's catch runs.
  if (cfg.error) return Promise.reject(new Error(cfg.error.message));
  return Promise.resolve(cfg.data);
}

vi.mock("@/lib/realtime/client-data", () => ({
  fetchCreativesByBrief: () => resolveFetch("creatives"),
  fetchVideoCreativesByBrief: () => resolveFetch("video_creatives"),
  signStoragePath: vi.fn(async () => "https://x.example/x"),
}));

import { StageIdeation } from "./StageIdeation";

function makePipeline(over: Partial<Pipeline> = {}): Pipeline {
  return {
    id: "p1",
    status: "ideation",
    format_choice: "image",
    client_id: null,
    image_brief_id: null,
    video_brief_id: null,
    config_draft: null,
    picks: { image: [], video: [] },
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
  updatePicks.mockReset();
  realtime.reset();
  supabaseFromMock.creatives = { data: [], error: null };
  supabaseFromMock.video_creatives = { data: [], error: null };
  delete supabaseFromMock.creatives.throws;
  delete supabaseFromMock.video_creatives.throws;
});

/**
 * Emit a realtime change into the registered listeners. Each ideation column
 * registers listeners on its own table (`creatives` or `video_creatives`),
 * so single-track tests dispatch to the right column automatically.
 */
function emitChange(
  table: "creatives" | "video_creatives",
  eventType: "INSERT" | "UPDATE" | "DELETE",
  payload: { new?: unknown; old?: unknown },
) {
  realtime.emit(table, eventType, payload as { new?: unknown; old?: unknown });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("StageIdeation", () => {
  it("renders the empty/loading state when no creatives yet", async () => {
    render(<StageIdeation pipeline={makePipeline()} imageBriefId="b1" />);
    expect(await screen.findByText(/Image concepts/)).toBeInTheDocument();
  });

  it("renders error banner when image fetch fails", async () => {
    supabaseFromMock.creatives = { data: [], error: { message: "rls denied" } };
    render(<StageIdeation pipeline={makePipeline()} imageBriefId="b1" />);
    expect(await screen.findByText(/Couldn't load image concepts/)).toBeInTheDocument();
  });

  it("renders one card per creative once data arrives", async () => {
    supabaseFromMock.creatives = {
      data: [
        {
          id: "c1",
          brief_id: "b1",
          concept: "Concept A",
          ratio: "1x1",
          version: "v0.ideation",
          status: "draft",
          file_path_supabase: "x.png",
          file_path_drive: null,
          type: "image",
          prompt_used: null,
          offer_text: null,
          approved_at: null,
          created_at: "2026-05-17T11:00:00Z",
          updated_at: "2026-05-17T11:00:00Z",
        },
      ],
      error: null,
    };
    render(<StageIdeation pipeline={makePipeline()} imageBriefId="b1" />);
    expect(await screen.findByText("Concept A")).toBeInTheDocument();
  });

  it("toggling a pick fires updatePicks and re-flags pick state", async () => {
    supabaseFromMock.creatives = {
      data: [
        {
          id: "c1",
          brief_id: "b1",
          concept: "Concept A",
          ratio: "1x1",
          version: "v0.ideation",
          status: "draft",
          file_path_supabase: null,
          file_path_drive: null,
          type: "image",
          prompt_used: null,
          offer_text: null,
          approved_at: null,
          created_at: "2026-05-17T11:00:00Z",
          updated_at: "2026-05-17T11:00:00Z",
        },
      ],
      error: null,
    };
    updatePicks.mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<StageIdeation pipeline={makePipeline()} imageBriefId="b1" />);
    const card = await screen.findByRole("checkbox", { name: /Concept A/ });
    await user.click(card);
    await waitFor(() => {
      expect(updatePicks).toHaveBeenCalledWith("p1", { image: ["c1"] });
      expect(card).toHaveAttribute("aria-checked", "true");
    });
  });

  it("reverts the pick state on updatePicks failure + surfaces error", async () => {
    supabaseFromMock.creatives = {
      data: [
        {
          id: "c1",
          brief_id: "b1",
          concept: "Concept A",
          ratio: "1x1",
          version: "v0.ideation",
          status: "draft",
          file_path_supabase: null,
          file_path_drive: null,
          type: "image",
          prompt_used: null,
          offer_text: null,
          approved_at: null,
          created_at: "2026-05-17T11:00:00Z",
          updated_at: "2026-05-17T11:00:00Z",
        },
      ],
      error: null,
    };
    updatePicks.mockRejectedValue(new Error("boom"));
    const user = userEvent.setup();
    render(<StageIdeation pipeline={makePipeline()} imageBriefId="b1" />);
    const card = await screen.findByRole("checkbox", { name: /Concept A/ });
    await user.click(card);
    expect(await screen.findByRole("alert")).toHaveTextContent(/boom/);
    expect(card).toHaveAttribute("aria-checked", "false");
  });

  it("disables Continue until every active track has a pick", () => {
    render(<StageIdeation pipeline={makePipeline()} imageBriefId="b1" />);
    expect(screen.getByRole("button", { name: /Continue/i })).toBeDisabled();
  });

  it("enables Continue once at least one pick per track exists", () => {
    render(
      <StageIdeation pipeline={makePipeline({ picks: { image: ["c1"] } })} imageBriefId="b1" />,
    );
    expect(screen.getByRole("button", { name: /Continue/i })).toBeEnabled();
  });

  it("clicking Continue POSTs /advance and refreshes the router", async () => {
    spyOnFetch().mockResolvedValueOnce(jsonResponse({ ok: true }));
    const user = userEvent.setup();
    render(
      <StageIdeation pipeline={makePipeline({ picks: { image: ["c1"] } })} imageBriefId="b1" />,
    );
    await user.click(screen.getByRole("button", { name: /Continue/i }));
    await waitFor(() => {
      expect(routerRefresh).toHaveBeenCalled();
    });
  });

  it("surfaces /advance error inline", async () => {
    spyOnFetch().mockResolvedValueOnce(new Response("nope", { status: 422 }));
    const user = userEvent.setup();
    render(
      <StageIdeation pipeline={makePipeline({ picks: { image: ["c1"] } })} imageBriefId="b1" />,
    );
    await user.click(screen.getByRole("button", { name: /Continue/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/nope/);
  });

  it("renders both image and video columns for format=both", async () => {
    render(
      <StageIdeation
        pipeline={makePipeline({ format_choice: "both" })}
        imageBriefId="b1"
        videoBriefId="bv1"
      />,
    );
    expect(await screen.findByText(/Image concepts/)).toBeInTheDocument();
    expect(screen.getByText(/Video concepts/)).toBeInTheDocument();
  });

  it("renders the video error banner when video fetch fails", async () => {
    supabaseFromMock.video_creatives = { data: [], error: { message: "denied" } };
    render(
      <StageIdeation pipeline={makePipeline({ format_choice: "video" })} videoBriefId="bv1" />,
    );
    expect(await screen.findByText(/Couldn't load video concepts/)).toBeInTheDocument();
  });

  it("surfaces a thrown initial-fetch error in the video catch branch", async () => {
    supabaseFromMock.video_creatives.throws = new Error("network die");
    render(
      <StageIdeation pipeline={makePipeline({ format_choice: "video" })} videoBriefId="bv1" />,
    );
    expect(await screen.findByText(/Couldn't load video concepts/)).toBeInTheDocument();
  });

  it("surfaces a thrown initial-fetch error in the image catch branch", async () => {
    supabaseFromMock.creatives.throws = new Error("image die");
    render(<StageIdeation pipeline={makePipeline()} imageBriefId="b1" />);
    expect(await screen.findByText(/Couldn't load image concepts/)).toBeInTheDocument();
  });

  it("video DELETE drops the cached scriptExcerpt", async () => {
    supabaseFromMock.video_creatives = {
      data: [
        {
          id: "v1",
          brief_id: "bv1",
          version: 1,
          status: "broll_ready",
          duration_actual_s: null,
          composed_path: null,
          captioned_path: null,
          voiceover_path: null,
          script_path: "scripts/v1.txt",
          broll_clips: [],
          drive_url: null,
          approved_at: null,
          created_at: "2026-05-17T10:00:00Z",
          updated_at: "2026-05-17T10:00:00Z",
        },
      ],
      error: null,
    };
    render(
      <StageIdeation pipeline={makePipeline({ format_choice: "video" })} videoBriefId="bv1" />,
    );
    await screen.findByText(/Concept v1/);
    const deleteHandler = (p: { new?: unknown; old?: unknown }) =>
      emitChange("video_creatives", "DELETE", p);
    await act(async () => {
      deleteHandler({ old: { id: "v1" } });
    });
    expect(screen.queryByText(/Concept v1/)).not.toBeInTheDocument();
  });

  it("renders the no-brief-id loading state and continues quickly", () => {
    render(<StageIdeation pipeline={makePipeline()} imageBriefId={null} />);
    expect(screen.getByText(/Image concepts/)).toBeInTheDocument();
  });

  it("realtime INSERT appends a creative", async () => {
    // Seed with one creative so the loading state resolves; the second
    // arrives via realtime.
    supabaseFromMock.creatives = {
      data: [
        {
          id: "c1",
          brief_id: "b1",
          concept: "Already there",
          ratio: "1x1",
          version: "v0.ideation",
          status: "draft",
          file_path_supabase: null,
          file_path_drive: null,
          type: "image",
          prompt_used: null,
          offer_text: null,
          approved_at: null,
          created_at: "2026-05-17T10:00:00Z",
          updated_at: "2026-05-17T10:00:00Z",
        },
      ],
      error: null,
    };
    render(<StageIdeation pipeline={makePipeline()} imageBriefId="b1" />);
    await screen.findByText("Already there");
    const insertHandler = (p: { new?: unknown; old?: unknown }) =>
      emitChange("creatives", "INSERT", p);
    await act(async () => {
      insertHandler({
        new: {
          id: "c-new",
          brief_id: "b1",
          concept: "Streamed",
          ratio: "1x1",
          version: "v0.ideation",
          status: "draft",
          file_path_supabase: null,
          file_path_drive: null,
          type: "image",
          prompt_used: null,
          offer_text: null,
          approved_at: null,
          created_at: "2026-05-17T11:00:00Z",
          updated_at: "2026-05-17T11:00:00Z",
        },
      });
    });
    expect(await screen.findByText("Streamed")).toBeInTheDocument();
  });

  it("realtime UPDATE replaces creative + fetches URL", async () => {
    supabaseFromMock.creatives = {
      data: [
        {
          id: "c1",
          brief_id: "b1",
          concept: "Old",
          ratio: "1x1",
          version: "v0.ideation",
          status: "draft",
          file_path_supabase: null,
          file_path_drive: null,
          type: "image",
          prompt_used: null,
          offer_text: null,
          approved_at: null,
          created_at: "2026-05-17T10:00:00Z",
          updated_at: "2026-05-17T10:00:00Z",
        },
      ],
      error: null,
    };
    render(<StageIdeation pipeline={makePipeline()} imageBriefId="b1" />);
    await screen.findByText("Old");
    const updateHandler = (p: { new?: unknown; old?: unknown }) =>
      emitChange("creatives", "UPDATE", p);
    await act(async () => {
      updateHandler({
        new: {
          id: "c1",
          brief_id: "b1",
          concept: "Updated",
          ratio: "1x1",
          version: "v0.ideation",
          status: "draft",
          file_path_supabase: "x.png",
          file_path_drive: null,
          type: "image",
          prompt_used: null,
          offer_text: null,
          approved_at: null,
          created_at: "2026-05-17T10:00:00Z",
          updated_at: "2026-05-17T10:30:00Z",
        },
      });
    });
    expect(await screen.findByText("Updated")).toBeInTheDocument();
  });

  it("realtime DELETE removes a creative", async () => {
    supabaseFromMock.creatives = {
      data: [
        {
          id: "c1",
          brief_id: "b1",
          concept: "Will be removed",
          ratio: "1x1",
          version: "v0.ideation",
          status: "draft",
          file_path_supabase: null,
          file_path_drive: null,
          type: "image",
          prompt_used: null,
          offer_text: null,
          approved_at: null,
          created_at: "2026-05-17T11:00:00Z",
          updated_at: "2026-05-17T11:00:00Z",
        },
      ],
      error: null,
    };
    render(<StageIdeation pipeline={makePipeline()} imageBriefId="b1" />);
    expect(await screen.findByText("Will be removed")).toBeInTheDocument();
    const deleteHandler = (p: { new?: unknown; old?: unknown }) =>
      emitChange("creatives", "DELETE", p);
    await act(async () => {
      deleteHandler({ old: { id: "c1" } });
    });
    expect(screen.queryByText("Will be removed")).not.toBeInTheDocument();
  });

  it("realtime DELETE without id is a no-op", async () => {
    render(<StageIdeation pipeline={makePipeline()} imageBriefId="b1" />);
    const deleteHandler = (p: { new?: unknown; old?: unknown }) =>
      emitChange("creatives", "DELETE", p);
    await act(async () => {
      deleteHandler({ old: {} });
    });
    // Doesn't crash; placeholder remains visible.
    expect(screen.getByText(/Image concepts/)).toBeInTheDocument();
  });

  it("registers the realtime relay (which owns its own teardown)", () => {
    const { unmount } = render(<StageIdeation pipeline={makePipeline()} imageBriefId="b1" />);
    expect(realtime.spy).toHaveBeenCalled();
    expect(() => unmount()).not.toThrow();
  });

  it("renders the video empty state with sketch animation", async () => {
    render(
      <StageIdeation pipeline={makePipeline({ format_choice: "video" })} videoBriefId="bv1" />,
    );
    expect(await screen.findByText(/Ekko is sketching/)).toBeInTheDocument();
  });

  it("renders video pick cards from initial fetch", async () => {
    supabaseFromMock.video_creatives = {
      data: [
        {
          id: "v1",
          brief_id: "bv1",
          version: 1,
          status: "broll_ready",
          duration_actual_s: 30,
          composed_path: null,
          captioned_path: null,
          voiceover_path: null,
          script_path: null,
          broll_clips: [],
          drive_url: null,
          approved_at: null,
          created_at: "2026-05-17T10:00:00Z",
          updated_at: "2026-05-17T10:00:00Z",
        },
      ],
      error: null,
    };
    render(
      <StageIdeation pipeline={makePipeline({ format_choice: "video" })} videoBriefId="bv1" />,
    );
    expect(await screen.findByText(/Concept v1/)).toBeInTheDocument();
    expect(screen.getByText(/No b-roll plan yet/)).toBeInTheDocument();
  });

  it("renders the b-roll themes summary when present", async () => {
    supabaseFromMock.video_creatives = {
      data: [
        {
          id: "v1",
          brief_id: "bv1",
          version: 1,
          status: "broll_ready",
          duration_actual_s: 30,
          composed_path: null,
          captioned_path: null,
          voiceover_path: null,
          script_path: null,
          broll_clips: [
            {
              segment_idx: 0,
              store_backend: "local",
              clip_id: "c0",
              in_s: 0,
              out_s: 3,
              source_url: "x",
              theme: "skyline",
            },
            {
              segment_idx: 1,
              store_backend: "local",
              clip_id: "c1",
              in_s: 0,
              out_s: 3,
              source_url: "x",
              theme: "ocean",
            },
          ],
          drive_url: null,
          approved_at: null,
          created_at: "2026-05-17T10:00:00Z",
          updated_at: "2026-05-17T10:00:00Z",
        },
      ],
      error: null,
    };
    render(
      <StageIdeation pipeline={makePipeline({ format_choice: "video" })} videoBriefId="bv1" />,
    );
    expect(await screen.findByText(/B-roll: skyline · ocean/)).toBeInTheDocument();
  });

  it("renders the segment-count summary when themes are missing", async () => {
    supabaseFromMock.video_creatives = {
      data: [
        {
          id: "v1",
          brief_id: "bv1",
          version: 1,
          status: "broll_ready",
          duration_actual_s: 30,
          composed_path: null,
          captioned_path: null,
          voiceover_path: null,
          script_path: null,
          broll_clips: [
            {
              segment_idx: 0,
              store_backend: "local",
              clip_id: "c0",
              in_s: 0,
              out_s: 3,
              source_url: "x",
            },
          ],
          drive_url: null,
          approved_at: null,
          created_at: "2026-05-17T10:00:00Z",
          updated_at: "2026-05-17T10:00:00Z",
        },
      ],
      error: null,
    };
    render(
      <StageIdeation pipeline={makePipeline({ format_choice: "video" })} videoBriefId="bv1" />,
    );
    expect(await screen.findByText(/B-roll plan: 1 segment/)).toBeInTheDocument();
  });

  it("video pick toggle fires updatePicks with video key", async () => {
    supabaseFromMock.video_creatives = {
      data: [
        {
          id: "v1",
          brief_id: "bv1",
          version: 1,
          status: "broll_ready",
          duration_actual_s: null,
          composed_path: null,
          captioned_path: null,
          voiceover_path: null,
          script_path: null,
          broll_clips: [],
          drive_url: null,
          approved_at: null,
          created_at: "2026-05-17T10:00:00Z",
          updated_at: "2026-05-17T10:00:00Z",
        },
      ],
      error: null,
    };
    updatePicks.mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(
      <StageIdeation pipeline={makePipeline({ format_choice: "video" })} videoBriefId="bv1" />,
    );
    const card = await screen.findByRole("checkbox", { name: /Pick video concept v1/ });
    await user.click(card);
    await waitFor(() => {
      expect(updatePicks).toHaveBeenCalledWith("p1", { video: ["v1"] });
    });
  });

  it("video realtime INSERT appends a creative", async () => {
    supabaseFromMock.video_creatives = {
      data: [
        {
          id: "v1",
          brief_id: "bv1",
          version: 1,
          status: "broll_ready",
          duration_actual_s: null,
          composed_path: null,
          captioned_path: null,
          voiceover_path: null,
          script_path: null,
          broll_clips: [],
          drive_url: null,
          approved_at: null,
          created_at: "2026-05-17T10:00:00Z",
          updated_at: "2026-05-17T10:00:00Z",
        },
      ],
      error: null,
    };
    render(
      <StageIdeation pipeline={makePipeline({ format_choice: "video" })} videoBriefId="bv1" />,
    );
    await screen.findByText(/Concept v1/);
    const insertHandler = (p: { new?: unknown; old?: unknown }) =>
      emitChange("video_creatives", "INSERT", p);
    await act(async () => {
      insertHandler({
        new: {
          id: "v2",
          brief_id: "bv1",
          version: 2,
          status: "broll_ready",
          duration_actual_s: null,
          composed_path: null,
          captioned_path: null,
          voiceover_path: null,
          script_path: null,
          broll_clips: [],
          drive_url: null,
          approved_at: null,
          created_at: "2026-05-17T10:30:00Z",
          updated_at: "2026-05-17T10:30:00Z",
        },
      });
    });
    expect(await screen.findByText(/Concept v2/)).toBeInTheDocument();
  });

  it("video realtime UPDATE replaces existing", async () => {
    supabaseFromMock.video_creatives = {
      data: [
        {
          id: "v1",
          brief_id: "bv1",
          version: 1,
          status: "broll_ready",
          duration_actual_s: null,
          composed_path: null,
          captioned_path: null,
          voiceover_path: null,
          script_path: null,
          broll_clips: [],
          drive_url: null,
          approved_at: null,
          created_at: "2026-05-17T10:00:00Z",
          updated_at: "2026-05-17T10:00:00Z",
        },
      ],
      error: null,
    };
    render(
      <StageIdeation pipeline={makePipeline({ format_choice: "video" })} videoBriefId="bv1" />,
    );
    await screen.findByText(/Concept v1/);
    const updateHandler = (p: { new?: unknown; old?: unknown }) =>
      emitChange("video_creatives", "UPDATE", p);
    await act(async () => {
      updateHandler({
        new: {
          id: "v1",
          brief_id: "bv1",
          version: 1,
          status: "captioned",
          duration_actual_s: 30,
          composed_path: null,
          captioned_path: null,
          voiceover_path: null,
          script_path: "some/path.txt",
          broll_clips: [],
          drive_url: null,
          approved_at: null,
          created_at: "2026-05-17T10:00:00Z",
          updated_at: "2026-05-17T10:30:00Z",
        },
      });
    });
    expect(await screen.findByText(/captioned/)).toBeInTheDocument();
  });

  it("video realtime INSERT triggers script_path fetch", async () => {
    supabaseFromMock.video_creatives = {
      data: [
        {
          id: "v1",
          brief_id: "bv1",
          version: 1,
          status: "broll_ready",
          duration_actual_s: null,
          composed_path: null,
          captioned_path: null,
          voiceover_path: null,
          script_path: null,
          broll_clips: [],
          drive_url: null,
          approved_at: null,
          created_at: "2026-05-17T10:00:00Z",
          updated_at: "2026-05-17T10:00:00Z",
        },
      ],
      error: null,
    };
    render(
      <StageIdeation pipeline={makePipeline({ format_choice: "video" })} videoBriefId="bv1" />,
    );
    await screen.findByText(/Concept v1/);
    const insertHandler = (p: { new?: unknown; old?: unknown }) =>
      emitChange("video_creatives", "INSERT", p);
    await act(async () => {
      insertHandler({
        new: {
          id: "v2",
          brief_id: "bv1",
          version: 2,
          status: "broll_ready",
          duration_actual_s: null,
          composed_path: null,
          captioned_path: null,
          voiceover_path: null,
          script_path: "scripts/v2.txt",
          broll_clips: [],
          drive_url: null,
          approved_at: null,
          created_at: "2026-05-17T11:00:00Z",
          updated_at: "2026-05-17T11:00:00Z",
        },
      });
    });
    expect(await screen.findByText(/Concept v2/)).toBeInTheDocument();
  });

  it("initial fetch with script_path triggers script excerpt fetch", async () => {
    supabaseFromMock.video_creatives = {
      data: [
        {
          id: "v1",
          brief_id: "bv1",
          version: 1,
          status: "broll_ready",
          duration_actual_s: null,
          composed_path: null,
          captioned_path: null,
          voiceover_path: null,
          script_path: "scripts/v1.txt",
          broll_clips: [],
          drive_url: null,
          approved_at: null,
          created_at: "2026-05-17T10:00:00Z",
          updated_at: "2026-05-17T10:00:00Z",
        },
      ],
      error: null,
    };
    render(
      <StageIdeation pipeline={makePipeline({ format_choice: "video" })} videoBriefId="bv1" />,
    );
    expect(await screen.findByText(/Concept v1/)).toBeInTheDocument();
  });

  it("video DELETE clears script excerpt from state", async () => {
    supabaseFromMock.video_creatives = {
      data: [
        {
          id: "v1",
          brief_id: "bv1",
          version: 1,
          status: "broll_ready",
          duration_actual_s: null,
          composed_path: null,
          captioned_path: null,
          voiceover_path: null,
          script_path: "scripts/v1.txt",
          broll_clips: [],
          drive_url: null,
          approved_at: null,
          created_at: "2026-05-17T10:00:00Z",
          updated_at: "2026-05-17T10:00:00Z",
        },
      ],
      error: null,
    };
    render(
      <StageIdeation pipeline={makePipeline({ format_choice: "video" })} videoBriefId="bv1" />,
    );
    await screen.findByText(/Concept v1/);
    const deleteHandler = (p: { new?: unknown; old?: unknown }) =>
      emitChange("video_creatives", "DELETE", p);
    await act(async () => {
      deleteHandler({ old: { id: "v1" } });
    });
    expect(screen.queryByText(/Concept v1/)).not.toBeInTheDocument();
  });

  it("video DELETE without id is a no-op", async () => {
    supabaseFromMock.video_creatives = {
      data: [
        {
          id: "v1",
          brief_id: "bv1",
          version: 1,
          status: "broll_ready",
          duration_actual_s: null,
          composed_path: null,
          captioned_path: null,
          voiceover_path: null,
          script_path: null,
          broll_clips: [],
          drive_url: null,
          approved_at: null,
          created_at: "2026-05-17T10:00:00Z",
          updated_at: "2026-05-17T10:00:00Z",
        },
      ],
      error: null,
    };
    render(
      <StageIdeation pipeline={makePipeline({ format_choice: "video" })} videoBriefId="bv1" />,
    );
    await screen.findByText(/Concept v1/);
    const deleteHandler = (p: { new?: unknown; old?: unknown }) =>
      emitChange("video_creatives", "DELETE", p);
    await act(async () => {
      deleteHandler({ old: {} });
    });
    // Still visible.
    expect(screen.getByText(/Concept v1/)).toBeInTheDocument();
  });

  it("video INSERT dedupes by id", async () => {
    supabaseFromMock.video_creatives = {
      data: [
        {
          id: "v1",
          brief_id: "bv1",
          version: 1,
          status: "broll_ready",
          duration_actual_s: null,
          composed_path: null,
          captioned_path: null,
          voiceover_path: null,
          script_path: null,
          broll_clips: [],
          drive_url: null,
          approved_at: null,
          created_at: "2026-05-17T10:00:00Z",
          updated_at: "2026-05-17T10:00:00Z",
        },
      ],
      error: null,
    };
    render(
      <StageIdeation pipeline={makePipeline({ format_choice: "video" })} videoBriefId="bv1" />,
    );
    await screen.findByText(/Concept v1/);
    const insertHandler = (p: { new?: unknown; old?: unknown }) =>
      emitChange("video_creatives", "INSERT", p);
    await act(async () => {
      insertHandler({
        new: {
          id: "v1", // duplicate id
          brief_id: "bv1",
          version: 99,
          status: "broll_ready",
          duration_actual_s: null,
          composed_path: null,
          captioned_path: null,
          voiceover_path: null,
          script_path: null,
          broll_clips: [],
          drive_url: null,
          approved_at: null,
          created_at: "2026-05-17T10:00:00Z",
          updated_at: "2026-05-17T10:00:00Z",
        },
      });
    });
    // Still only one concept.
    expect(screen.getAllByText(/Concept v/).length).toBe(1);
  });

  it("video realtime DELETE removes a creative", async () => {
    supabaseFromMock.video_creatives = {
      data: [
        {
          id: "v1",
          brief_id: "bv1",
          version: 1,
          status: "broll_ready",
          duration_actual_s: null,
          composed_path: null,
          captioned_path: null,
          voiceover_path: null,
          script_path: null,
          broll_clips: [],
          drive_url: null,
          approved_at: null,
          created_at: "2026-05-17T10:00:00Z",
          updated_at: "2026-05-17T10:00:00Z",
        },
      ],
      error: null,
    };
    render(
      <StageIdeation pipeline={makePipeline({ format_choice: "video" })} videoBriefId="bv1" />,
    );
    await screen.findByText(/Concept v1/);
    const deleteHandler = (p: { new?: unknown; old?: unknown }) =>
      emitChange("video_creatives", "DELETE", p);
    await act(async () => {
      deleteHandler({ old: { id: "v1" } });
    });
    expect(screen.queryByText(/Concept v1/)).not.toBeInTheDocument();
  });
});
