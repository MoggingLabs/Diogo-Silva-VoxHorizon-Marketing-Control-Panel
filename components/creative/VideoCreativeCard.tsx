"use client";

import { useState } from "react";
import { Clapperboard, Film, PlayCircle } from "lucide-react";

import { timeSince, formatDuration } from "@/lib/format-time";
import {
  STATUS_LABEL,
  STATUS_PILL,
  type VideoCreative,
  type VideoCreativeStatusT,
} from "@/lib/video-creatives";
import { cn } from "@/lib/utils";

export type VideoCreativeCardProps = {
  creative: VideoCreative;
  signedUrl: string | null;
  active?: boolean;
  onSelect: (id: string) => void;
};

/**
 * Map non-rendered statuses to a friendly tile placeholder. We can't show
 * a video poster until the captioned MP4 exists, so anything pre-`composed`
 * shows a Clapperboard with the stage label.
 */
const PLACEHOLDER_LABEL: Record<VideoCreativeStatusT, string> = {
  draft: "Awaiting script",
  script_ready: "Script ready",
  voiceover_ready: "Voiceover ready",
  broll_ready: "B-roll ready",
  composed: "Composing",
  captioned: "Captioned",
  approved: "Approved",
  rejected: "Rejected",
};

/**
 * A single tile in the video variants grid. Shows the captioned MP4
 * preview (or a stage placeholder when the worker hasn't reached
 * `composed`), a status pill, and version + actual-duration metadata.
 *
 * Click opens the side panel via `?creative=<id>` — the parent grid owns
 * URL state via `router.replace` so the navigation is shareable but
 * doesn't push to history.
 */
export function VideoCreativeCard({
  creative,
  signedUrl,
  active,
  onSelect,
}: VideoCreativeCardProps) {
  const status = creative.status as VideoCreativeStatusT;
  const pillClass = STATUS_PILL[status] ?? "bg-zinc-100 text-zinc-700";
  const pillLabel = STATUS_LABEL[status] ?? status;
  const versionLabel = `v${creative.version}`;
  const duration = formatDuration(creative.duration_actual_s);

  // Only show the inline <video> once we have a captioned (or composed)
  // signed URL. Earlier stages render the Clapperboard placeholder.
  const hasPreview = signedUrl !== null && (status === "captioned" || status === "approved");

  // Hover state lets us swap the static "frame 0" poster for a muted
  // autoplay-on-hover loop, matching the kind of UX operators expect
  // when scanning a grid of video variants.
  const [hovering, setHovering] = useState(false);

  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={() => onSelect(creative.id)}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
      className={cn(
        "group flex flex-col gap-2 overflow-hidden rounded-md border bg-card text-left shadow-sm",
        "transition-all hover:border-zinc-300 hover:shadow-md",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
        active ? "border-zinc-400 ring-1 ring-zinc-300" : "border-border",
      )}
    >
      <div className="relative aspect-square w-full overflow-hidden bg-muted/40">
        {hasPreview && signedUrl ? (
          <video
            src={signedUrl}
            preload="metadata"
            muted
            playsInline
            // Auto-play a muted preview on hover; reset on leave so the
            // tile stays cheap to render in large grids.
            {...(hovering ? { autoPlay: true, loop: true } : { autoPlay: false })}
            className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.02]"
          />
        ) : (
          <div className="flex h-full w-full flex-col items-center justify-center gap-1.5 text-muted-foreground">
            <Clapperboard aria-hidden="true" className="h-7 w-7" />
            <span className="text-[11px] font-medium">{PLACEHOLDER_LABEL[status]}</span>
          </div>
        )}
        {/* Play icon overlay when we have a preview, lightly highlighted on hover */}
        {hasPreview ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center opacity-0 transition-opacity group-hover:opacity-90">
            <PlayCircle aria-hidden="true" className="h-12 w-12 text-white drop-shadow" />
          </div>
        ) : null}
        <span
          className={cn(
            "absolute right-2 top-2 rounded-full px-2 py-0.5 text-[11px] font-medium shadow",
            pillClass,
          )}
        >
          {pillLabel}
        </span>
      </div>
      <div className="flex flex-col gap-1 px-3 pb-3 pt-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="inline-flex min-w-0 items-center gap-1 truncate text-sm font-medium text-foreground">
            <Film aria-hidden="true" className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="truncate">Video</span>
          </span>
          <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
            {versionLabel}
          </span>
        </div>
        <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
          <span className="font-mono">{duration}</span>
          <span>{timeSince(creative.created_at)}</span>
        </div>
      </div>
    </button>
  );
}
