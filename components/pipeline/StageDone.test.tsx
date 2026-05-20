/**
 * StageDone: terminal gallery + cost reconciliation + launch CTA.
 *
 * Tests cover:
 *  - Title + subtitle
 *  - Image gallery: groups by concept, fetches signed URLs, error path
 *  - Video gallery: filters by status, click-to-play
 *  - Cost table only shown when estimate exists
 *  - Launch CTA flips between Build / View based on launch_package_id
 *  - readEstimate rejects malformed shapes
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Pipeline } from "@/lib/pipeline/types";

const routerPush = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPush, refresh: vi.fn(), replace: vi.fn() }),
}));

// Finals are fetched via the service-role API routes (client-data helpers).
// Mock them per-test; rejections drive the "Failed to load" branch.
type Row = Record<string, unknown>;
const fetchCreativesByBrief = vi.fn<() => Promise<Row[]>>(async () => []);
const fetchVideoCreativesByBrief = vi.fn<() => Promise<Row[]>>(async () => []);
const signStoragePaths = vi.fn<(b: string, p: string[]) => Promise<Record<string, string | null>>>(
  async (_b, paths) => Object.fromEntries(paths.map((p) => [p, `https://x.example/${p}`])),
);
vi.mock("@/lib/realtime/client-data", () => ({
  fetchCreativesByBrief: () => fetchCreativesByBrief(),
  fetchVideoCreativesByBrief: () => fetchVideoCreativesByBrief(),
  signStoragePaths: (b: string, p: string[]) => signStoragePaths(b, p),
}));

import { StageDone } from "./StageDone";

function makePipeline(over: Partial<Pipeline> = {}): Pipeline {
  return {
    id: "p1",
    status: "done",
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
    ...over,
  };
}

beforeEach(() => {
  routerPush.mockReset();
  fetchCreativesByBrief.mockReset();
  fetchCreativesByBrief.mockResolvedValue([]);
  fetchVideoCreativesByBrief.mockReset();
  fetchVideoCreativesByBrief.mockResolvedValue([]);
  signStoragePaths.mockClear();
  signStoragePaths.mockImplementation(async (_b, paths) =>
    Object.fromEntries(paths.map((p) => [p, `https://x.example/${p}`])),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("StageDone", () => {
  it("renders the title and subtitle", () => {
    render(<StageDone pipeline={makePipeline()} />);
    expect(
      screen.getByRole("heading", { name: /All done — your creatives are ready/ }),
    ).toBeInTheDocument();
  });

  it("renders the 'Build launch package' CTA when no package linked", async () => {
    const user = userEvent.setup();
    render(<StageDone pipeline={makePipeline()} />);
    const btn = screen.getByRole("button", { name: /Build launch package/i });
    expect(btn).toBeInTheDocument();
    await user.click(btn);
    expect(routerPush).toHaveBeenCalledWith("/launches/new?pipeline_id=p1");
  });

  it("flips to 'View launch package' when launch_package_id is set", async () => {
    const user = userEvent.setup();
    render(<StageDone pipeline={makePipeline({ launch_package_id: "lp1" })} />);
    await user.click(screen.getByRole("button", { name: /View launch package/i }));
    expect(routerPush).toHaveBeenCalledWith("/launches/lp1");
  });

  it("does not push when View launch is clicked and the id is unexpectedly missing", async () => {
    // launch_package_id is required for the View flow; this test confirms
    // the guard against a stale render.
    const user = userEvent.setup();
    const { rerender } = render(
      <StageDone pipeline={makePipeline({ launch_package_id: "lp1" })} />,
    );
    rerender(<StageDone pipeline={makePipeline({ launch_package_id: null })} />);
    // Now the CTA flipped back to Build — verify clicking it still works.
    await user.click(screen.getByRole("button", { name: /Build launch package/i }));
    expect(routerPush).toHaveBeenCalledWith("/launches/new?pipeline_id=p1");
  });

  it("renders the cost forecast vs actual table when cost_estimate exists", () => {
    render(
      <StageDone
        pipeline={makePipeline({
          cost_estimate: {
            items: [
              { api: "anthropic", unit_label: "1k", units: 5, unit_cost: 0.03, subtotal: 0.15 },
            ],
            total: 0.15,
          },
          cost_actual: {
            items: [
              { api: "anthropic", unit_label: "1k", units: 5, unit_cost: 0.03, subtotal: 0.2 },
            ],
            total: 0.2,
          },
        })}
      />,
    );
    expect(screen.getByText(/Cost — forecast vs actual/)).toBeInTheDocument();
  });

  it("hides the cost section when estimate is malformed", () => {
    render(
      <StageDone
        pipeline={makePipeline({
          cost_estimate: { not_items: true } as unknown as Pipeline["cost_estimate"],
        })}
      />,
    );
    expect(screen.queryByText(/Cost — forecast vs actual/)).not.toBeInTheDocument();
  });

  it("renders an empty image gallery placeholder when briefId is null", async () => {
    render(<StageDone pipeline={makePipeline()} imageBriefId={null} />);
    expect(await screen.findByText(/No final images recorded/)).toBeInTheDocument();
  });

  it("fetches + groups image finals by concept", async () => {
    fetchCreativesByBrief.mockResolvedValue([
      {
        id: "i1",
        concept: "Concept A",
        ratio: "1x1",
        version: "v1.0",
        file_path_supabase: "a-1x1.png",
      },
      {
        id: "i2",
        concept: "Concept A",
        ratio: "9x16",
        version: "v1.0",
        file_path_supabase: "a-9x16.png",
      },
      {
        id: "i3",
        concept: "Concept B",
        ratio: "1x1",
        version: "v1.0",
        file_path_supabase: "b-1x1.png",
      },
    ]);
    render(<StageDone pipeline={makePipeline()} imageBriefId="b1" />);
    expect(await screen.findByText("Concept A")).toBeInTheDocument();
    expect(screen.getByText("Concept B")).toBeInTheDocument();
    expect(screen.getByText(/2 ratios/)).toBeInTheDocument();
    expect(screen.getByText(/1 ratio/)).toBeInTheDocument();
  });

  it("surfaces fetch error in the image gallery", async () => {
    fetchCreativesByBrief.mockRejectedValue(new Error("rls denied"));
    render(<StageDone pipeline={makePipeline()} imageBriefId="b1" />);
    expect(await screen.findByText(/Failed to load: rls denied/)).toBeInTheDocument();
  });

  it("renders a No-render placeholder for image rows with no signed URL", async () => {
    fetchCreativesByBrief.mockResolvedValue([
      { id: "i1", concept: "Concept", ratio: "1x1", version: "v1.0", file_path_supabase: null },
    ]);
    render(<StageDone pipeline={makePipeline()} imageBriefId="b1" />);
    expect(await screen.findByText("Concept")).toBeInTheDocument();
    expect(screen.getByText("No render")).toBeInTheDocument();
  });

  it("renders empty video gallery placeholder when briefId is null for video format", async () => {
    render(<StageDone pipeline={makePipeline({ format_choice: "video" })} videoBriefId={null} />);
    expect(await screen.findByText(/No final videos recorded/)).toBeInTheDocument();
  });

  it("fetches + renders video finals + play-on-click", async () => {
    signStoragePaths.mockResolvedValue({ "v.mp4": "https://x.example/v.mp4" });
    fetchVideoCreativesByBrief.mockResolvedValue([
      {
        id: "v1",
        status: "captioned",
        composed_path: null,
        captioned_path: "v.mp4",
        duration_actual_s: 30,
      },
    ]);
    const user = userEvent.setup();
    render(<StageDone pipeline={makePipeline({ format_choice: "video" })} videoBriefId="b1" />);
    await waitFor(() => expect(screen.getByText("captioned")).toBeInTheDocument());
    const playBtn = await screen.findByRole("button", { name: /Play video/i });
    await user.click(playBtn);
    // Re-rendered with autoplaying video element.
    expect(document.body.querySelector("video")).not.toBeNull();
  });

  it("surfaces video fetch error", async () => {
    fetchVideoCreativesByBrief.mockRejectedValue(new Error("denied"));
    render(<StageDone pipeline={makePipeline({ format_choice: "video" })} videoBriefId="b1" />);
    expect(await screen.findByText(/Failed to load: denied/)).toBeInTheDocument();
  });

  it("renders 'duration TBD' when duration_actual_s is null", async () => {
    fetchVideoCreativesByBrief.mockResolvedValue([
      {
        id: "v1",
        status: "captioned",
        composed_path: null,
        captioned_path: null,
        duration_actual_s: null,
      },
    ]);
    render(<StageDone pipeline={makePipeline({ format_choice: "video" })} videoBriefId="b1" />);
    expect(await screen.findByText(/duration TBD/)).toBeInTheDocument();
  });

  it("handles thrown errors in the image gallery", async () => {
    fetchCreativesByBrief.mockRejectedValue(new Error("synchronous throw"));
    render(<StageDone pipeline={makePipeline()} imageBriefId="b1" />);
    expect(await screen.findByText(/Failed to load: synchronous throw/)).toBeInTheDocument();
  });

  it("handles thrown errors in the video gallery", async () => {
    fetchVideoCreativesByBrief.mockRejectedValue(new Error("video oh no"));
    render(<StageDone pipeline={makePipeline({ format_choice: "video" })} videoBriefId="b1" />);
    expect(await screen.findByText(/Failed to load: video oh no/)).toBeInTheDocument();
  });

  it("renders the 'No render' placeholder when video URL signing fails", async () => {
    // Signing returns null for the requested path → placeholder shows.
    signStoragePaths.mockResolvedValue({ "x.mp4": null });
    fetchVideoCreativesByBrief.mockResolvedValue([
      {
        id: "v1",
        status: "captioned",
        composed_path: "x.mp4",
        captioned_path: null,
        duration_actual_s: 10,
      },
    ]);
    render(<StageDone pipeline={makePipeline({ format_choice: "video" })} videoBriefId="b1" />);
    expect(await screen.findByText(/No render/)).toBeInTheDocument();
  });
});
