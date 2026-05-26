/**
 * VideoCreativeManage (E4.2 / #594): the per-creative video manage surface.
 * Mirrors the image manage test.
 */
import { render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { VideoCreative } from "@/lib/video-creatives";

const routerRefresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: routerRefresh, push: vi.fn(), replace: vi.fn() }),
}));

const updateVideoMock = vi.fn();
const archiveMock = vi.fn();
const restoreMock = vi.fn();
vi.mock("@/lib/creatives-client", () => ({
  updateVideoCreative: (...a: unknown[]) => updateVideoMock(...a),
  archiveCreative: (...a: unknown[]) => archiveMock(...a),
  restoreCreative: (...a: unknown[]) => restoreMock(...a),
}));

vi.mock("@/lib/realtime/client-data", () => ({
  fetchVideoIterations: vi.fn(async () => []),
}));

vi.mock("@/components/creative/VideoDecisionButtons", () => ({
  VideoDecisionButtons: ({ creativeId, status }: { creativeId: string; status: string }) => (
    <div data-testid="video-decision" data-id={creativeId} data-status={status} />
  ),
}));
vi.mock("@/components/creative/VideoIterationThread", () => ({
  VideoIterationThread: () => <div data-testid="video-thread" />,
}));
// ManagedGatePanels is covered by its own test; mock it here so the video
// manage tests stay focused on the page shell.
vi.mock("@/components/creative/ManagedGatePanels", () => ({
  ManagedGatePanels: ({
    creativeId,
    pipelineId,
    surface,
  }: {
    creativeId: string;
    pipelineId: string | null;
    surface: string;
  }) => (
    <div
      data-testid="managed-gate-panels"
      data-creative={creativeId}
      data-pipeline={pipelineId ?? ""}
      data-surface={surface}
    />
  ),
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { VideoCreativeManage } from "./VideoCreativeManage";

function creative(over: Partial<VideoCreative> = {}): VideoCreative {
  return {
    id: "v1",
    brief_id: "vb1",
    status: "captioned",
    version: 2,
    asset_name: "Hero cut",
    approved_at: null,
    captioned_path: "c.mp4",
    composed_path: null,
    voiceover_path: null,
    script_path: null,
    drive_url: null,
    drive_folder_id: null,
    duration_actual_s: 30,
    file_path_drive: null,
    finalize_verified: false,
    finalized_at: null,
    gen_model: null,
    music_track_used: null,
    pipeline_id: "pp1",
    render_cost_usd: null,
    script_outline: null,
    broll_clips: null,
    broll_sources: null,
    clip_count: null,
    created_at: "2026-05-20T10:00:00Z",
    deleted_at: null,
    ...over,
  } as VideoCreative;
}

const baseProps = {
  brief: { id: "vb1", brief_id_human: "vbr-1", status: "approved", client_id: "cl1" },
  signedUrl: "https://signed/c.mp4",
  copyVariants: [],
  qa: [],
  spec: [],
  compliance: [],
  stageState: [],
};

beforeEach(() => {
  routerRefresh.mockReset();
  updateVideoMock.mockReset().mockResolvedValue({});
  archiveMock.mockReset().mockResolvedValue(undefined);
  restoreMock.mockReset().mockResolvedValue(undefined);
});

afterEach(() => vi.clearAllMocks());

describe("VideoCreativeManage", () => {
  it("shows VideoDecisionButtons for a non-terminal status", () => {
    render(<VideoCreativeManage creative={creative({ status: "captioned" })} {...baseProps} />);
    const dec = screen.getByTestId("video-decision");
    expect(dec).toHaveAttribute("data-id", "v1");
    expect(dec).toHaveAttribute("data-status", "captioned");
  });

  it("shows a summary (no buttons) once terminal", () => {
    render(
      <VideoCreativeManage
        creative={creative({ status: "approved", approved_at: "2026-05-21T00:00:00Z" })}
        {...baseProps}
      />,
    );
    expect(screen.queryByTestId("video-decision")).not.toBeInTheDocument();
    expect(screen.getByText(/Decided/i)).toBeInTheDocument();
  });

  it("edits asset_name through the drawer -> PATCH + refresh", async () => {
    const user = userEvent.setup();
    render(<VideoCreativeManage creative={creative()} {...baseProps} />);
    await user.click(screen.getByRole("button", { name: /edit metadata/i }));
    const dialog = await screen.findByRole("dialog");
    const name = within(dialog).getByLabelText(/asset name/i);
    await user.clear(name);
    await user.type(name, "Renamed");
    await user.click(within(dialog).getByRole("button", { name: /save/i }));
    await waitFor(() => expect(updateVideoMock).toHaveBeenCalled());
    expect(updateVideoMock.mock.calls[0]![1]).toMatchObject({ asset_name: "Renamed" });
    expect(routerRefresh).toHaveBeenCalled();
  });

  it("archives through the confirm dialog", async () => {
    const user = userEvent.setup();
    render(<VideoCreativeManage creative={creative()} {...baseProps} />);
    await user.click(screen.getByRole("button", { name: /^archive$/i }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: /^archive$/i }));
    await waitFor(() => expect(archiveMock).toHaveBeenCalledWith("video", "v1"));
  });

  it("restores an archived video creative", async () => {
    const user = userEvent.setup();
    render(
      <VideoCreativeManage
        creative={creative({ deleted_at: "2026-05-22T00:00:00Z" })}
        {...baseProps}
      />,
    );
    await user.click(screen.getByRole("button", { name: /restore/i }));
    await waitFor(() => expect(restoreMock).toHaveBeenCalledWith("video", "v1"));
  });

  it("renders copy variants + the managed gate panels (video surface) with a pipeline link", () => {
    render(
      <VideoCreativeManage
        creative={creative()}
        {...baseProps}
        copyVariants={[
          { id: "cv1", platform: "tiktok", headline: "Hook", body: "Body", status: "draft" },
        ]}
        qa={[{ id: "qa1", attempt: 2, status: "fail" }]}
        spec={[{ id: "sp1", platform: "meta", placement: "reels", status: "pass" }]}
        compliance={[{ id: "cf1", rule_id: "R9", verdict: "pass", overridden: false }]}
        stageState={[{ id: "ss1", stage: "compose", status: "cleared" }]}
      />,
    );
    expect(screen.getByText("Hook")).toBeInTheDocument();
    const panels = screen.getByTestId("managed-gate-panels");
    expect(panels).toHaveAttribute("data-creative", "v1");
    expect(panels).toHaveAttribute("data-pipeline", "pp1");
    expect(panels).toHaveAttribute("data-surface", "video");
    expect(screen.getByText("compose")).toBeInTheDocument();
    const links = screen.getAllByRole("link", { name: /pipeline/i });
    expect(links.some((a) => a.getAttribute("href") === "/pipeline/pp1")).toBe(true);
  });

  it("renders placeholder + null pipeline + no pipeline link when unrendered/unlinked", () => {
    render(
      <VideoCreativeManage
        creative={creative({ pipeline_id: null, captioned_path: null, composed_path: null })}
        {...baseProps}
        brief={null}
        signedUrl={null}
        stageState={[]}
      />,
    );
    expect(screen.getByText(/No rendered video yet/i)).toBeInTheDocument();
    expect(screen.getByTestId("managed-gate-panels")).toHaveAttribute("data-pipeline", "");
    expect(screen.getByText(/No gate state/i)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /review in pipeline/i })).not.toBeInTheDocument();
    expect(screen.getByText(/flow through the decision routes only/i)).toBeInTheDocument();
  });

  it("renders a bare copy variant + bare stage-state row (falsy optional fields)", () => {
    render(
      <VideoCreativeManage
        creative={creative({ duration_actual_s: null, asset_name: null })}
        {...baseProps}
        copyVariants={[{ id: "cv0" }]}
        qa={[{ id: "qa0" }]}
        spec={[{ id: "sp0" }]}
        compliance={[{ id: "cf0" }]}
        stageState={[{ id: "ss0" }]}
      />,
    );
    expect(screen.getByText("Copy variants (1)")).toBeInTheDocument();
    // asset_name null -> title falls back to "Video creative v<version>".
    expect(screen.getByRole("heading", { name: /Video creative v2/i })).toBeInTheDocument();
  });

  it("surfaces an iterations load error", async () => {
    const { fetchVideoIterations } = await import("@/lib/realtime/client-data");
    (fetchVideoIterations as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("iter boom"),
    );
    render(<VideoCreativeManage creative={creative()} {...baseProps} />);
    expect(await screen.findByText(/iter boom/i)).toBeInTheDocument();
  });

  it("toasts on a restore failure", async () => {
    const user = userEvent.setup();
    const { toast } = await import("sonner");
    restoreMock.mockRejectedValueOnce(new Error("restore boom"));
    render(
      <VideoCreativeManage
        creative={creative({ deleted_at: "2026-05-22T00:00:00Z" })}
        {...baseProps}
      />,
    );
    await user.click(screen.getByRole("button", { name: /restore/i }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("restore boom"));
  });
});
