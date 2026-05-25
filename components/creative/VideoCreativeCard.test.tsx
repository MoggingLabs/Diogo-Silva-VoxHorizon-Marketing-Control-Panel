/**
 * VideoCreativeCard mirrors CreativeCard but has video-specific behaviour:
 *  - Inline <video> preview only when status is captioned/approved AND we
 *    have a signed URL.
 *  - Mouse hover toggles the autoPlay attribute.
 *  - Earlier statuses show a Clapperboard placeholder with a stage label.
 *  - Duration + version labels render correctly.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { VideoCreative } from "@/lib/video-creatives";

import { VideoCreativeCard } from "./VideoCreativeCard";

function makeCreative(over: Partial<VideoCreative> = {}): VideoCreative {
  return {
    id: "v1",
    brief_id: "b1",
    version: 1,
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
    updated_at: "2026-05-17T11:00:00Z",
    ...(over as object),
  } as unknown as VideoCreative;
}

describe("VideoCreativeCard", () => {
  it("renders an inline <video> when status=captioned and a URL is available", () => {
    const { container } = render(
      <VideoCreativeCard
        creative={makeCreative()}
        signedUrl="https://x.example/v.mp4"
        onSelect={() => {}}
      />,
    );
    const video = container.querySelector("video");
    expect(video).not.toBeNull();
    expect(video?.getAttribute("src")).toBe("https://x.example/v.mp4");
  });

  it("renders an inline <video> when status=approved", () => {
    const { container } = render(
      <VideoCreativeCard
        creative={makeCreative({ status: "approved" })}
        signedUrl="https://x.example/v.mp4"
        onSelect={() => {}}
      />,
    );
    expect(container.querySelector("video")).not.toBeNull();
  });

  it("shows the Clapperboard placeholder for pre-captioned statuses", () => {
    render(
      <VideoCreativeCard
        creative={makeCreative({ status: "draft" })}
        signedUrl={null}
        onSelect={() => {}}
      />,
    );
    expect(screen.getByText(/Awaiting script/)).toBeInTheDocument();
  });

  it.each([
    ["script_ready", /Script ready/],
    ["voiceover_ready", /Voiceover ready/],
    ["broll_ready", /B-roll ready/],
    ["composed", /Composing/],
    ["rejected", /Rejected/],
  ] as const)("shows the right placeholder label for status=%s", (status, label) => {
    render(
      <VideoCreativeCard
        creative={makeCreative({ status })}
        signedUrl={null}
        onSelect={() => {}}
      />,
    );
    expect(screen.getAllByText(label).length).toBeGreaterThan(0);
  });

  it("falls back to a generic pill class when status is unknown", () => {
    render(
      <VideoCreativeCard
        creative={makeCreative({ status: "weird" as VideoCreative["status"] })}
        signedUrl={null}
        onSelect={() => {}}
      />,
    );
    expect(screen.getAllByText(/weird/i).length).toBeGreaterThan(0);
  });

  it("renders the version label as v<N>", () => {
    render(
      <VideoCreativeCard
        creative={makeCreative({ version: 3 })}
        signedUrl="x"
        onSelect={() => {}}
      />,
    );
    expect(screen.getByText("v3")).toBeInTheDocument();
  });

  it("fires onSelect with the creative id on click", async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(<VideoCreativeCard creative={makeCreative()} signedUrl="x" onSelect={onSelect} />);
    await user.click(screen.getByRole("button"));
    expect(onSelect).toHaveBeenCalledWith("v1");
  });

  it("flips the autoPlay attribute on hover", async () => {
    const { container } = render(
      <VideoCreativeCard
        creative={makeCreative()}
        signedUrl="https://x.example/v.mp4"
        onSelect={() => {}}
      />,
    );
    const card = screen.getByRole("button");
    const video = container.querySelector("video")!;
    expect(video.hasAttribute("autoplay")).toBe(false);
    fireEvent.mouseEnter(card);
    expect(container.querySelector("video")!.hasAttribute("autoplay")).toBe(true);
    fireEvent.mouseLeave(card);
    expect(container.querySelector("video")!.hasAttribute("autoplay")).toBe(false);
  });

  it("sets aria-pressed when active is true", () => {
    render(
      <VideoCreativeCard creative={makeCreative()} signedUrl={null} active onSelect={() => {}} />,
    );
    expect(screen.getByRole("button")).toHaveAttribute("aria-pressed", "true");
  });
});
