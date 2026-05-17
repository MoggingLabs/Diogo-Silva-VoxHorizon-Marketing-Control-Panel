/**
 * VideoSidePanel is the larger video twin of SidePanel — preview, script
 * outline, voiceover audio, b-roll grid, iterations thread, and review_each
 * BrollSelector. Tests focus on the branches unique to video.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mockSupabaseClient, type SupabaseClientMock } from "@/tests/unit/helpers/supabase-mock";
import type { VideoCreative } from "@/lib/video-creatives";
import type { VideoBrief } from "@/lib/video-briefs";

let currentClient: SupabaseClientMock = mockSupabaseClient();

vi.mock("@/lib/supabase/browser", () => ({
  createClient: () => currentClient,
}));

vi.mock("@/lib/chat-read-status", () => ({
  countUnread: vi.fn(() => 1),
  getLastSeen: vi.fn(async () => null),
  markRead: vi.fn(async () => {}),
}));

vi.mock("./VideoIterationThread", () => ({
  VideoIterationThread: ({ creativeId }: { creativeId: string }) => (
    <div data-testid="video-iter">{creativeId}</div>
  ),
}));
vi.mock("./VideoDecisionButtons", () => ({
  VideoDecisionButtons: ({ creativeId }: { creativeId: string }) => (
    <div data-testid="video-decision">{creativeId}</div>
  ),
}));
vi.mock("./BrollSelector", () => ({
  BrollSelector: ({ videoCreativeId }: { videoCreativeId: string }) => (
    <div data-testid="broll-selector">{videoCreativeId}</div>
  ),
}));
vi.mock("@/components/chat/EkkoChat", () => ({
  EkkoChat: ({ creativeId }: { creativeId: string }) => (
    <div data-testid="ekko-chat">{creativeId}</div>
  ),
}));
vi.mock("@/components/chat/UnreadDivider", () => ({
  UnreadDivider: ({ count }: { count: number }) => <div data-testid="unread-divider">{count}</div>,
}));
vi.mock("@/components/chat/ThreadSearch", () => ({
  ThreadSearch: ({ open }: { open: boolean }) => (open ? <div data-testid="search-bar" /> : null),
  useThreadSearchShortcut: () => {},
}));

import { VideoSidePanel } from "./VideoSidePanel";

function makeCreative(over: Partial<VideoCreative> = {}): VideoCreative {
  return {
    id: "v1",
    brief_id: "b1",
    version: 2,
    status: "captioned",
    duration_actual_s: 30,
    composed_path: null,
    captioned_path: null,
    voiceover_path: null,
    script_path: null,
    broll_clips: null,
    drive_url: null,
    approved_at: null,
    created_at: "2026-05-17T11:00:00Z",
    updated_at: "2026-05-17T11:30:00Z",
    ...(over as object),
  } as VideoCreative;
}

const briefStub: VideoBrief = {
  id: "b1",
  client_id: "c1",
  script_outline: {
    hook: "What's happening here?",
    segments: [
      { topic: "Intro", duration_s: 10 },
      { topic: "Body", duration_s: 15, broll_theme: "skyline" },
    ],
  },
  target_duration_s: 30,
  voice_id: "v1",
  music_track: null,
  hook_style: null,
  dimensions: "9x16",
  captions_style: "bold_yellow",
  broll_selection_mode: "auto",
  notes: null,
  status: "approved",
  created_at: "2026-05-17T10:00:00Z",
  updated_at: "2026-05-17T10:00:00Z",
} as unknown as VideoBrief;

beforeEach(() => {
  currentClient = mockSupabaseClient({
    video_iterations: { select: { error: null, data: [] } },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("VideoSidePanel", () => {
  it("renders the 'not found' state when creative is null", () => {
    render(
      <VideoSidePanel
        creative={null}
        brief={briefStub}
        captionedUrl={null}
        composedUrl={null}
        voiceoverUrl={null}
        open
        onOpenChange={() => {}}
      />,
    );
    expect(screen.getByText(/Video creative not found/)).toBeInTheDocument();
  });

  it("renders the captioned video when captionedUrl is set", () => {
    render(
      <VideoSidePanel
        creative={makeCreative()}
        brief={briefStub}
        captionedUrl="https://x.example/c.mp4"
        composedUrl="https://x.example/comp.mp4"
        voiceoverUrl={null}
        open
        onOpenChange={() => {}}
      />,
    );
    const video = document.body.querySelector("video");
    expect(video?.getAttribute("src")).toBe("https://x.example/c.mp4");
    expect(screen.getByText(/captioned MP4/)).toBeInTheDocument();
  });

  it("falls back to composed MP4 when no captioned URL", () => {
    render(
      <VideoSidePanel
        creative={makeCreative()}
        brief={briefStub}
        captionedUrl={null}
        composedUrl="https://x.example/comp.mp4"
        voiceoverUrl={null}
        open
        onOpenChange={() => {}}
      />,
    );
    expect(document.body.querySelector("video")?.getAttribute("src")).toBe(
      "https://x.example/comp.mp4",
    );
    expect(screen.getByText(/composed MP4 \(no captions yet\)/)).toBeInTheDocument();
  });

  it("renders the no-preview placeholder when no URL is available", () => {
    render(
      <VideoSidePanel
        creative={makeCreative()}
        brief={briefStub}
        captionedUrl={null}
        composedUrl={null}
        voiceoverUrl={null}
        open
        onOpenChange={() => {}}
      />,
    );
    expect(screen.getByText(/No video render yet/)).toBeInTheDocument();
  });

  it("collapses and re-expands the script section", async () => {
    const user = userEvent.setup();
    render(
      <VideoSidePanel
        creative={makeCreative()}
        brief={briefStub}
        captionedUrl={null}
        composedUrl={null}
        voiceoverUrl={null}
        open
        onOpenChange={() => {}}
      />,
    );
    expect(
      screen.getByText((briefStub.script_outline as { hook: string }).hook),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Hide/i }));
    expect(
      screen.queryByText((briefStub.script_outline as { hook: string }).hook),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Show/i }));
    expect(
      screen.getByText((briefStub.script_outline as { hook: string }).hook),
    ).toBeInTheDocument();
  });

  it("renders the unstructured outline message when brief has no script", () => {
    render(
      <VideoSidePanel
        creative={makeCreative()}
        brief={{ ...briefStub, script_outline: null } as VideoBrief}
        captionedUrl={null}
        composedUrl={null}
        voiceoverUrl={null}
        open
        onOpenChange={() => {}}
      />,
    );
    expect(screen.getByText(/No structured script outline/)).toBeInTheDocument();
  });

  it("renders voiceover audio when URL provided", () => {
    render(
      <VideoSidePanel
        creative={makeCreative()}
        brief={briefStub}
        captionedUrl={null}
        composedUrl={null}
        voiceoverUrl="https://x.example/v.mp3"
        open
        onOpenChange={() => {}}
      />,
    );
    expect(document.body.querySelector("audio")).not.toBeNull();
    expect(screen.getAllByText(/v1/).length).toBeGreaterThan(0);
  });

  it("renders the no-voiceover placeholder when missing", () => {
    render(
      <VideoSidePanel
        creative={makeCreative()}
        brief={briefStub}
        captionedUrl={null}
        composedUrl={null}
        voiceoverUrl={null}
        open
        onOpenChange={() => {}}
      />,
    );
    expect(screen.getByText(/No voiceover yet/)).toBeInTheDocument();
  });

  it("renders the b-roll grid when clips present", () => {
    const creative = makeCreative({
      broll_clips: [
        {
          segment_idx: 0,
          store_backend: "local",
          clip_id: "c1",
          in_s: 0,
          out_s: 3,
          source_url: "https://x.example/c1",
          thumbnail_url: "thumb.png",
          theme: "skyline",
        },
      ],
    } as unknown as Partial<VideoCreative>);
    render(
      <VideoSidePanel
        creative={creative}
        brief={briefStub}
        captionedUrl={null}
        composedUrl={null}
        voiceoverUrl={null}
        open
        onOpenChange={() => {}}
      />,
    );
    expect(screen.getByText(/B-roll clips \(1\)/)).toBeInTheDocument();
    expect(screen.getByText(/Seg 1 · c1/)).toBeInTheDocument();
    expect(screen.getAllByText(/skyline/).length).toBeGreaterThan(0);
  });

  it("renders the b-roll placeholder when none present", () => {
    render(
      <VideoSidePanel
        creative={makeCreative()}
        brief={briefStub}
        captionedUrl={null}
        composedUrl={null}
        voiceoverUrl={null}
        open
        onOpenChange={() => {}}
      />,
    );
    expect(screen.getByText(/No b-roll picks yet/)).toBeInTheDocument();
  });

  it("fetches iterations on open and surfaces error", async () => {
    currentClient = mockSupabaseClient({
      video_iterations: { select: { data: null, error: { message: "boom" } } },
    });
    render(
      <VideoSidePanel
        creative={makeCreative()}
        brief={briefStub}
        captionedUrl={null}
        composedUrl={null}
        voiceoverUrl={null}
        open
        onOpenChange={() => {}}
      />,
    );
    expect(await screen.findByText(/Failed to load iterations: boom/)).toBeInTheDocument();
  });

  it("renders the iteration thread when fetch succeeds", async () => {
    currentClient = mockSupabaseClient({
      video_iterations: {
        select: { error: null, data: [{ id: "i1", creative_id: "v1", created_at: "x" }] },
      },
    });
    render(
      <VideoSidePanel
        creative={makeCreative()}
        brief={briefStub}
        captionedUrl={null}
        composedUrl={null}
        voiceoverUrl={null}
        open
        onOpenChange={() => {}}
      />,
    );
    expect(await screen.findByTestId("video-iter")).toHaveTextContent("v1");
  });

  it("renders the BrollSelector when broll_selection_mode=review_each and candidates exist", () => {
    const creative = makeCreative({
      broll_clips: {
        candidates: {
          "0": [
            {
              segment_idx: 0,
              store_backend: "local",
              clip_id: "c-a",
              in_s: 0,
              out_s: 3,
              source_url: "https://x.example/c-a",
            },
          ],
        },
      },
    } as unknown as Partial<VideoCreative>);
    render(
      <VideoSidePanel
        creative={creative}
        brief={{ ...briefStub, broll_selection_mode: "review_each" } as VideoBrief}
        captionedUrl={null}
        composedUrl={null}
        voiceoverUrl={null}
        open
        onOpenChange={() => {}}
      />,
    );
    expect(screen.getByTestId("broll-selector")).toHaveTextContent("v1");
  });

  it("renders the decision summary when status is approved with a decided_at", () => {
    render(
      <VideoSidePanel
        creative={makeCreative({ status: "approved", approved_at: "2026-05-17T11:45:00Z" })}
        brief={briefStub}
        captionedUrl={null}
        composedUrl={null}
        voiceoverUrl={null}
        open
        onOpenChange={() => {}}
      />,
    );
    expect(screen.getByText(/Decided /)).toBeInTheDocument();
  });

  it("opens the thread search via the header button", async () => {
    const user = userEvent.setup();
    render(
      <VideoSidePanel
        creative={makeCreative()}
        brief={briefStub}
        captionedUrl={null}
        composedUrl={null}
        voiceoverUrl={null}
        open
        onOpenChange={() => {}}
      />,
    );
    expect(screen.queryByTestId("search-bar")).not.toBeInTheDocument();
    await user.click(screen.getByLabelText(/Search this thread/));
    expect(await screen.findByTestId("search-bar")).toBeInTheDocument();
  });

  it("approved status maps to 'captioned' stage in tracker + adds Approved chip", () => {
    render(
      <VideoSidePanel
        creative={makeCreative({ status: "approved" })}
        brief={briefStub}
        captionedUrl={null}
        composedUrl={null}
        voiceoverUrl={null}
        open
        onOpenChange={() => {}}
      />,
    );
    expect(screen.getAllByText(/Approved/).length).toBeGreaterThan(0);
  });

  it("rejected status adds a Rejected chip in the tracker", () => {
    render(
      <VideoSidePanel
        creative={makeCreative({ status: "rejected" })}
        brief={briefStub}
        captionedUrl={null}
        composedUrl={null}
        voiceoverUrl={null}
        open
        onOpenChange={() => {}}
      />,
    );
    expect(screen.getAllByText(/Rejected/).length).toBeGreaterThan(0);
  });

  it("renders the drive link when drive_url is set", () => {
    render(
      <VideoSidePanel
        creative={makeCreative({ drive_url: "https://drive.example/x" })}
        brief={briefStub}
        captionedUrl={null}
        composedUrl={null}
        voiceoverUrl={null}
        open
        onOpenChange={() => {}}
      />,
    );
    expect(screen.getByRole("link", { name: /Open/i })).toHaveAttribute(
      "href",
      "https://drive.example/x",
    );
  });

  it("renders the unread divider with computed count", async () => {
    render(
      <VideoSidePanel
        creative={makeCreative()}
        brief={briefStub}
        captionedUrl={null}
        composedUrl={null}
        voiceoverUrl={null}
        open
        onOpenChange={() => {}}
      />,
    );
    expect(await screen.findByTestId("unread-divider")).toHaveTextContent("1");
  });
});
