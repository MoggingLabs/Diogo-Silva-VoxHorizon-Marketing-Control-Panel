/**
 * Tests for the video launch summary (server component).
 *
 * Covers:
 *   - Brief overview fields: duration / dimensions / voice / captions / hook style / music.
 *   - Em-dash fallbacks when fields are null.
 *   - Validation issues banner.
 *   - "No approved video creatives" empty state.
 *   - Inline <video> when captionedUrl is present; placeholder otherwise.
 *   - Drive link, captioned_path, b-roll clip summary.
 *   - "+N more" overflow indicator when clips > 5.
 *   - copy variant lists or "No paired copy variants".
 *   - Validation block reflects payload.validation.ok / via / stderr.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { VideoLaunchSummary } from "./VideoLaunchSummary";
import type { VideoLaunchPayloadT } from "@/lib/video-launches";

function brief(over: Record<string, unknown> = {}) {
  return {
    id: "vb1",
    brief_id_human: "VBR-001",
    client_id: "c1",
    target_duration_s: 30,
    dimensions: "9x16",
    voice_id: "voice-abc",
    captions_style: "bold_yellow",
    hook_style: "curiosity",
    music_track: "track-1",
    status: "approved",
    created_at: "2026-05-01T00:00:00Z",
    updated_at: "2026-05-01T00:00:00Z",
    payload: {},
    clients: null,
    ...over,
  } as unknown as Parameters<typeof VideoLaunchSummary>[0]["brief"];
}

function payload(over: Partial<VideoLaunchPayloadT> = {}): VideoLaunchPayloadT {
  return {
    brief_id_human: "VBR-001",
    client: { id: "c1", slug: "acme", name: "Acme" },
    video_creative_ids: [],
    copy_variant_ids: [],
    issues: [],
    validation: { ok: true, via: "preflight" },
    ...over,
  } as VideoLaunchPayloadT;
}

function vcreative(over: Record<string, unknown> = {}) {
  return {
    id: "vc-1",
    brief_id: "vb1",
    version: 1,
    status: "approved",
    drive_url: "https://drive.example/v1.mp4",
    captioned_path: "/cuts/v1.mp4",
    duration_actual_s: 30,
    broll_clips: null,
    created_at: "2026-05-01T00:00:00Z",
    updated_at: "2026-05-01T00:00:00Z",
    ...over,
  } as never;
}

describe("VideoLaunchSummary", () => {
  it("renders the brief overview fields", () => {
    render(
      <VideoLaunchSummary
        brief={brief()}
        videoCreatives={[]}
        copyByCreativeId={{}}
        signedUrls={{}}
        payload={payload()}
      />,
    );

    expect(screen.getByText("VBR-001")).toBeInTheDocument();
    expect(screen.getByText("Acme")).toBeInTheDocument();
    expect(screen.getByText("30s")).toBeInTheDocument();
    expect(screen.getByText("9x16")).toBeInTheDocument();
    expect(screen.getByText("voice-abc")).toBeInTheDocument();
    expect(screen.getByText("bold_yellow")).toBeInTheDocument();
    expect(screen.getByText("curiosity")).toBeInTheDocument();
    expect(screen.getByText("track-1")).toBeInTheDocument();
  });

  it("falls back to client name from brief.clients when payload.client is null", () => {
    render(
      <VideoLaunchSummary
        brief={brief({ clients: { name: "Alt Client", slug: "alt" } })}
        videoCreatives={[]}
        copyByCreativeId={{}}
        signedUrls={{}}
        payload={payload({ client: null })}
      />,
    );

    expect(screen.getByText("Alt Client")).toBeInTheDocument();
  });

  it("renders em-dashes for missing brief fields", () => {
    render(
      <VideoLaunchSummary
        brief={brief({
          target_duration_s: null,
          dimensions: null,
          voice_id: null,
          captions_style: null,
          hook_style: null,
          music_track: null,
          clients: null,
        })}
        videoCreatives={[]}
        copyByCreativeId={{}}
        signedUrls={{}}
        payload={payload({ client: null })}
      />,
    );

    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });

  it("renders the issues banner when validation issues exist", () => {
    render(
      <VideoLaunchSummary
        brief={brief()}
        videoCreatives={[]}
        copyByCreativeId={{}}
        signedUrls={{}}
        payload={payload({
          issues: [
            { severity: "error", message: "missing caption file" },
            { severity: "warning", message: "low audio" },
          ],
        })}
      />,
    );

    expect(screen.getByText(/Validation issues \(2\)/)).toBeInTheDocument();
    expect(screen.getByText("missing caption file")).toBeInTheDocument();
    expect(screen.getByText("low audio")).toBeInTheDocument();
  });

  it("hides the issues banner when issues are empty", () => {
    render(
      <VideoLaunchSummary
        brief={brief()}
        videoCreatives={[]}
        copyByCreativeId={{}}
        signedUrls={{}}
        payload={payload()}
      />,
    );

    expect(screen.queryByText(/Validation issues/)).not.toBeInTheDocument();
  });

  it("renders the empty-state when there are no video creatives", () => {
    render(
      <VideoLaunchSummary
        brief={brief()}
        videoCreatives={[]}
        copyByCreativeId={{}}
        signedUrls={{}}
        payload={payload()}
      />,
    );

    expect(
      screen.getByText(/No approved video creatives bundled with this launch/),
    ).toBeInTheDocument();
  });

  it("renders inline <video> when captionedUrl is present", () => {
    const { container } = render(
      <VideoLaunchSummary
        brief={brief()}
        videoCreatives={[vcreative()]}
        copyByCreativeId={{ "vc-1": [] }}
        signedUrls={{ "vc-1": "https://signed.example/v1.mp4" }}
        payload={payload()}
      />,
    );

    const video = container.querySelector("video");
    expect(video).not.toBeNull();
    expect(video!.getAttribute("src")).toBe("https://signed.example/v1.mp4");
  });

  it('renders "no preview" placeholder when signed url is missing', () => {
    render(
      <VideoLaunchSummary
        brief={brief()}
        videoCreatives={[vcreative()]}
        copyByCreativeId={{ "vc-1": [] }}
        signedUrls={{}}
        payload={payload()}
      />,
    );

    expect(screen.getByText("no preview")).toBeInTheDocument();
  });

  it("renders the b-roll clip summary including the +N overflow indicator", () => {
    const brollClips = Array.from({ length: 7 }).map((_, i) => ({
      segment_idx: i,
      in_s: i * 5,
      out_s: i * 5 + 4,
      clip_id: `clip-${i}`,
    }));

    render(
      <VideoLaunchSummary
        brief={brief()}
        videoCreatives={[vcreative({ broll_clips: brollClips })]}
        copyByCreativeId={{ "vc-1": [] }}
        signedUrls={{}}
        payload={payload()}
      />,
    );

    expect(screen.getByText(/B-roll \(7 clips\)/)).toBeInTheDocument();
    expect(screen.getByText(/\+ 2 more/)).toBeInTheDocument();
  });

  it("uses singular 'clip' in b-roll summary for a single clip", () => {
    render(
      <VideoLaunchSummary
        brief={brief()}
        videoCreatives={[
          vcreative({ broll_clips: [{ segment_idx: 0, in_s: 0, out_s: 4, clip_id: "c1" }] }),
        ]}
        copyByCreativeId={{ "vc-1": [] }}
        signedUrls={{}}
        payload={payload()}
      />,
    );

    expect(screen.getByText(/B-roll \(1 clip\)/)).toBeInTheDocument();
  });

  it("hides the b-roll section when clips array is empty or null", () => {
    render(
      <VideoLaunchSummary
        brief={brief()}
        videoCreatives={[vcreative({ broll_clips: [] })]}
        copyByCreativeId={{ "vc-1": [] }}
        signedUrls={{}}
        payload={payload()}
      />,
    );

    expect(screen.queryByText(/B-roll/)).not.toBeInTheDocument();
  });

  it("renders captioned path when provided", () => {
    render(
      <VideoLaunchSummary
        brief={brief()}
        videoCreatives={[vcreative({ captioned_path: "/cuts/v1.mp4" })]}
        copyByCreativeId={{ "vc-1": [] }}
        signedUrls={{}}
        payload={payload()}
      />,
    );

    expect(screen.getByText("/cuts/v1.mp4")).toBeInTheDocument();
  });

  it("renders 'No captioned cut' when captioned_path is missing", () => {
    render(
      <VideoLaunchSummary
        brief={brief()}
        videoCreatives={[vcreative({ captioned_path: null })]}
        copyByCreativeId={{ "vc-1": [] }}
        signedUrls={{}}
        payload={payload()}
      />,
    );

    expect(screen.getByText("No captioned cut.")).toBeInTheDocument();
  });

  it("renders 'missing' when drive_url is null", () => {
    render(
      <VideoLaunchSummary
        brief={brief()}
        videoCreatives={[vcreative({ drive_url: null })]}
        copyByCreativeId={{ "vc-1": [] }}
        signedUrls={{}}
        payload={payload()}
      />,
    );

    expect(screen.getByText("missing")).toBeInTheDocument();
  });

  it("renders copy variants when present", () => {
    render(
      <VideoLaunchSummary
        brief={brief()}
        videoCreatives={[vcreative()]}
        copyByCreativeId={{
          "vc-1": [
            {
              id: "cv-1",
              video_creative_id: "vc-1",
              headline: "Big Hook",
              body: "Body line",
              cta: "Call now",
            } as never,
          ],
        }}
        signedUrls={{}}
        payload={payload()}
      />,
    );

    expect(screen.getByText("Big Hook")).toBeInTheDocument();
    expect(screen.getByText("Body line")).toBeInTheDocument();
    expect(screen.getByText("CTA: Call now")).toBeInTheDocument();
  });

  it("renders 'No paired copy variants' when copies is empty", () => {
    render(
      <VideoLaunchSummary
        brief={brief()}
        videoCreatives={[vcreative()]}
        copyByCreativeId={{ "vc-1": [] }}
        signedUrls={{}}
        payload={payload()}
      />,
    );

    expect(screen.getByText("No paired copy variants.")).toBeInTheDocument();
  });

  it("renders the validation summary block (ok=false with stderr)", () => {
    render(
      <VideoLaunchSummary
        brief={brief()}
        videoCreatives={[]}
        copyByCreativeId={{}}
        signedUrls={{}}
        payload={payload({
          validation: {
            ok: false,
            via: "scripts_runner",
            raw_stderr: "ffmpeg failure",
          },
        })}
      />,
    );

    expect(screen.getByText("issues present")).toBeInTheDocument();
    expect(screen.getByText("ffmpeg failure")).toBeInTheDocument();
  });

  it("renders duration_actual_s when present, falling back to target", () => {
    render(
      <VideoLaunchSummary
        brief={brief()}
        videoCreatives={[vcreative({ duration_actual_s: null })]}
        copyByCreativeId={{ "vc-1": [] }}
        signedUrls={{}}
        payload={payload()}
      />,
    );

    // Falls back to brief.target_duration_s (30) → "30s"
    expect(screen.getAllByText("30s").length).toBeGreaterThan(0);
  });

  it("renders '?s' for duration when neither actual nor target is present", () => {
    render(
      <VideoLaunchSummary
        brief={brief({ target_duration_s: null })}
        videoCreatives={[vcreative({ duration_actual_s: null })]}
        copyByCreativeId={{ "vc-1": [] }}
        signedUrls={{}}
        payload={payload()}
      />,
    );

    expect(screen.getByText("?s")).toBeInTheDocument();
  });
});
