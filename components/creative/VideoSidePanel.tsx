"use client";

import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, ExternalLink, Loader2 } from "lucide-react";

import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { createClient } from "@/lib/supabase/browser";
import { formatDate, formatDuration } from "@/lib/format-time";
import {
  STAGE_ORDER,
  STATUS_LABEL,
  STATUS_PILL,
  readBrollClips,
  type BrollClipT,
  type VideoCreative,
  type VideoCreativeStatusT,
  type VideoIteration,
} from "@/lib/video-creatives";
import { ScriptOutline, type ScriptOutlineT, type VideoBrief } from "@/lib/video-briefs";
import { cn } from "@/lib/utils";

import { VideoDecisionButtons } from "./VideoDecisionButtons";
import { VideoIterationThread } from "./VideoIterationThread";

export type VideoSidePanelProps = {
  creative: VideoCreative | null;
  brief: VideoBrief | null;
  /** Signed URL for the captioned MP4 (preferred preview source). */
  captionedUrl: string | null;
  /** Signed URL for the composed MP4 (fallback when captioning hasn't run). */
  composedUrl: string | null;
  /** Signed URL for the concatenated voiceover audio. */
  voiceoverUrl: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

/**
 * Slide-over panel for one video creative.
 *
 * Wider than the image side panel (`max-w-[640px]`) to fit:
 *  - Video preview (`<video controls />`) of the captioned MP4 (or composed
 *    fallback), with poster placeholder for earlier stages.
 *  - Collapsible **Script** section listing hook + segments from the
 *    owning brief's `script_outline`.
 *  - **Voiceover** section with an `<audio controls />` element.
 *  - **B-roll clips** grid of segment thumbnails (when present).
 *  - **Iteration thread** mirroring `creative_iterations` for the row.
 *  - **Decision** buttons via `<VideoDecisionButtons />`.
 *
 * Initial iterations are fetched on open; Realtime keeps them live.
 * Signed URLs are passed in from the parent (resolved server-side on
 * first paint, refreshed by the parent on Realtime updates).
 */
export function VideoSidePanel({
  creative,
  brief,
  captionedUrl,
  composedUrl,
  voiceoverUrl,
  open,
  onOpenChange,
}: VideoSidePanelProps) {
  const [iterations, setIterations] = useState<VideoIteration[]>([]);
  const [loadingIterations, setLoadingIterations] = useState(false);
  const [iterationsError, setIterationsError] = useState<string | null>(null);
  const [scriptOpen, setScriptOpen] = useState(true);

  useEffect(() => {
    if (!creative) return;
    let cancelled = false;
    setLoadingIterations(true);
    setIterationsError(null);
    const supabase = createClient();
    void supabase
      .from("video_iterations")
      .select("*")
      .eq("creative_id", creative.id)
      .order("created_at", { ascending: true })
      .limit(500)
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) {
          setIterationsError(error.message);
          setIterations([]);
        } else {
          setIterations((data ?? []) as VideoIteration[]);
        }
        setLoadingIterations(false);
      });
    return () => {
      cancelled = true;
    };
  }, [creative]);

  // Default the script section open when the panel changes creative.
  useEffect(() => {
    setScriptOpen(true);
  }, [creative?.id]);

  const outline: ScriptOutlineT | null = useMemo(() => {
    if (!brief?.script_outline) return null;
    const parsed = ScriptOutline.safeParse(brief.script_outline);
    return parsed.success ? parsed.data : null;
  }, [brief?.script_outline]);

  const brollClips = useMemo<BrollClipT[]>(
    () => (creative ? readBrollClips(creative.broll_clips) : []),
    [creative],
  );

  if (!creative) {
    return (
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent className="sm:max-w-[640px] md:max-w-[640px]">
          <SheetHeader>
            <SheetTitle>Video creative not found</SheetTitle>
            <SheetDescription>
              The selected video creative is no longer available. Close this panel and pick another
              variant.
            </SheetDescription>
          </SheetHeader>
        </SheetContent>
      </Sheet>
    );
  }

  const status = creative.status as VideoCreativeStatusT;
  const pillClass = STATUS_PILL[status] ?? "bg-zinc-100 text-zinc-700";
  const pillLabel = STATUS_LABEL[status] ?? status;
  const versionLabel = `v${creative.version}`;
  const duration = formatDuration(creative.duration_actual_s);
  const createdAt = formatDate(creative.created_at);
  const decidedAt = formatDate(creative.approved_at);

  // Prefer the captioned MP4 (final shippable asset); fall back to the
  // composed MP4 so operators can still preview mid-pipeline runs.
  const previewUrl = captionedUrl ?? composedUrl;
  const previewKind = captionedUrl ? "captioned" : composedUrl ? "composed" : null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="sm:max-w-[640px] md:max-w-[640px]">
        <SheetHeader className="pr-8">
          <div className="flex flex-wrap items-center gap-2">
            <SheetTitle className="truncate">Video creative</SheetTitle>
            <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium", pillClass)}>
              {pillLabel}
            </span>
          </div>
          <SheetDescription className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
            <span className="font-mono">{versionLabel}</span>
            <span aria-hidden="true">·</span>
            <span className="font-mono">{duration}</span>
            {brief?.dimensions ? (
              <>
                <span aria-hidden="true">·</span>
                <span className="font-mono">{brief.dimensions}</span>
              </>
            ) : null}
            {createdAt ? (
              <>
                <span aria-hidden="true">·</span>
                <span>{createdAt}</span>
              </>
            ) : null}
          </SheetDescription>
        </SheetHeader>

        <div className="mt-6 flex flex-col gap-6">
          {/* Stage tracker --------------------------------------------- */}
          <Section title="Pipeline progress">
            <StageTracker status={status} />
          </Section>

          {/* Preview --------------------------------------------------- */}
          <Section title="Preview">
            {previewUrl ? (
              <div className="space-y-1.5">
                <div className="overflow-hidden rounded-md border bg-black">
                  <video
                    src={previewUrl}
                    controls
                    preload="metadata"
                    playsInline
                    className="max-h-[420px] w-full bg-black"
                  />
                </div>
                <p className="text-[11px] text-muted-foreground">
                  Source:{" "}
                  {previewKind === "captioned" ? "captioned MP4" : "composed MP4 (no captions yet)"}
                </p>
              </div>
            ) : (
              <div className="rounded-md border border-dashed bg-muted/30 px-3 py-8 text-center text-xs text-muted-foreground">
                No video render yet. The worker reaches a previewable state at{" "}
                <span className="font-medium text-foreground">Composed</span>.
              </div>
            )}
          </Section>

          {/* Script ---------------------------------------------------- */}
          <Section
            title="Script"
            action={
              <button
                type="button"
                onClick={() => setScriptOpen((v) => !v)}
                className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground hover:bg-muted/60"
              >
                {scriptOpen ? (
                  <ChevronDown aria-hidden="true" className="h-3.5 w-3.5" />
                ) : (
                  <ChevronRight aria-hidden="true" className="h-3.5 w-3.5" />
                )}
                {scriptOpen ? "Hide" : "Show"}
              </button>
            }
          >
            {scriptOpen ? (
              outline ? (
                <div className="space-y-3">
                  <div className="rounded-md border bg-muted/30 px-3 py-2">
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                      Hook
                    </p>
                    <p className="mt-1 whitespace-pre-wrap text-sm text-foreground">
                      {outline.hook}
                    </p>
                  </div>
                  <ol className="space-y-2">
                    {outline.segments.map((seg, idx) => (
                      <li key={idx} className="rounded-md border bg-card px-3 py-2">
                        <div className="flex items-baseline justify-between gap-2">
                          <span className="text-sm font-medium text-foreground">
                            {idx + 1}. {seg.topic}
                          </span>
                          <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                            {seg.duration_s}s
                          </span>
                        </div>
                        {seg.broll_theme ? (
                          <p className="mt-1 text-xs text-muted-foreground">
                            <span className="font-medium">B-roll theme: </span>
                            {seg.broll_theme}
                          </p>
                        ) : null}
                      </li>
                    ))}
                  </ol>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">
                  No structured script outline on the brief yet.
                </p>
              )
            ) : null}
          </Section>

          {/* Voiceover ------------------------------------------------- */}
          <Section title="Voiceover">
            {voiceoverUrl ? (
              <div className="space-y-1.5">
                <audio src={voiceoverUrl} controls preload="metadata" className="w-full" />
                {brief?.voice_id ? (
                  <p className="text-[11px] text-muted-foreground">
                    Voice <span className="font-mono">{brief.voice_id}</span>
                  </p>
                ) : null}
              </div>
            ) : (
              <p className="rounded-md border border-dashed bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                No voiceover yet. Generated by the agent once the script is ready.
              </p>
            )}
          </Section>

          {/* B-roll clips ---------------------------------------------- */}
          <Section title={`B-roll clips${brollClips.length ? ` (${brollClips.length})` : ""}`}>
            {brollClips.length === 0 ? (
              <p className="rounded-md border border-dashed bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                No b-roll picks yet. Populated at the b-roll stage.
              </p>
            ) : (
              <ul className="grid grid-cols-2 gap-2">
                {brollClips.map((clip, idx) => (
                  <li
                    key={`${clip.clip_id}-${idx}`}
                    className="overflow-hidden rounded-md border bg-card"
                  >
                    {clip.thumbnail_url ? (
                      // eslint-disable-next-line @next/next/no-img-element -- external b-roll thumb URL, plain <img> is fine
                      <img
                        src={clip.thumbnail_url}
                        alt={clip.theme ?? `B-roll clip ${idx + 1}`}
                        loading="lazy"
                        className="aspect-video w-full bg-muted object-cover"
                      />
                    ) : (
                      <div className="flex aspect-video w-full items-center justify-center bg-muted text-muted-foreground">
                        <span className="text-[11px]">Segment {clip.segment_idx + 1}</span>
                      </div>
                    )}
                    <div className="px-2 py-1.5 text-[11px]">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="truncate font-medium text-foreground" title={clip.clip_id}>
                          Seg {clip.segment_idx + 1} · {clip.clip_id}
                        </span>
                        <span className="shrink-0 font-mono text-muted-foreground">
                          {formatDuration(Math.max(0, clip.out_s - clip.in_s))}
                        </span>
                      </div>
                      <div className="flex items-baseline justify-between gap-2 text-muted-foreground">
                        <span className="font-mono">
                          {clip.in_s.toFixed(1)}–{clip.out_s.toFixed(1)}s
                        </span>
                        <a
                          href={clip.source_url}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="inline-flex items-center gap-0.5 underline-offset-4 hover:underline"
                          onClick={(e) => e.stopPropagation()}
                        >
                          source
                          <ExternalLink aria-hidden="true" className="h-2.5 w-2.5" />
                        </a>
                      </div>
                      {clip.theme ? (
                        <p className="truncate text-muted-foreground" title={clip.theme}>
                          {clip.theme}
                        </p>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          {/* Metadata -------------------------------------------------- */}
          <Section title="Metadata">
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
              <Field label="Version" value={versionLabel} mono />
              <Field label="Duration" value={duration} mono />
              <Field label="Dimensions" value={brief?.dimensions ?? "—"} mono />
              <Field label="Voice" value={brief?.voice_id ?? "—"} mono />
              <Field label="Created" value={createdAt ?? "—"} />
              <Field
                label={status === "approved" ? "Approved" : "Decided"}
                value={decidedAt ?? "—"}
              />
              <Field
                label="Drive"
                value={
                  creative.drive_url ? (
                    <a
                      href={creative.drive_url}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="inline-flex items-center gap-1 underline-offset-4 hover:underline"
                    >
                      Open
                      <ExternalLink aria-hidden="true" className="h-3 w-3" />
                    </a>
                  ) : (
                    "—"
                  )
                }
              />
              <Field label="Captions style" value={brief?.captions_style ?? "—"} />
            </dl>
          </Section>

          {/* Iterations ------------------------------------------------ */}
          <Section title="Iterations">
            {loadingIterations ? (
              <p className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />
                Loading thread…
              </p>
            ) : iterationsError ? (
              <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                Failed to load iterations: {iterationsError}
              </p>
            ) : (
              <VideoIterationThread creativeId={creative.id} initialIterations={iterations} />
            )}
          </Section>

          {/* Decision -------------------------------------------------- */}
          <Section title="Decision">
            <VideoDecisionButtons creativeId={creative.id} status={status} />
            {decidedAt && (status === "approved" || status === "rejected") ? (
              <p className="mt-2 text-xs text-muted-foreground">
                Decided {decidedAt} · {pillLabel}
              </p>
            ) : null}
          </Section>

          <Section title="Chat with Ekko">
            <p className="rounded-md border border-dashed bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
              Chat / iterate lands in a future wave. For now use the decision buttons to drive next
              steps.
            </p>
          </Section>
        </div>
      </SheetContent>
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// Internal building blocks
// ---------------------------------------------------------------------------

function Section({
  title,
  action,
  children,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {title}
        </h3>
        {action}
      </div>
      {children}
    </section>
  );
}

function Field({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className={cn("break-words text-xs text-foreground", mono ? "font-mono" : undefined)}>
        {value}
      </dd>
    </div>
  );
}

/**
 * Compact horizontal step-tracker showing where the creative is in the
 * pipeline. Walks `STAGE_ORDER`; everything up to and including the
 * current status is highlighted.
 */
function StageTracker({ status }: { status: VideoCreativeStatusT }) {
  // Terminal statuses (approved / rejected) hang off the end of the
  // pipeline — both tags map to "fully done" for visual purposes.
  const effective: VideoCreativeStatusT =
    status === "approved" || status === "rejected" ? "captioned" : status;
  const currentIdx = STAGE_ORDER.indexOf(effective);
  return (
    <ol className="flex flex-wrap items-center gap-1.5 text-[11px]">
      {STAGE_ORDER.map((stage, idx) => {
        const reached = idx <= currentIdx;
        const current = idx === currentIdx;
        return (
          <li
            key={stage}
            className={cn(
              "inline-flex items-center gap-1 rounded-full border px-2 py-0.5",
              reached
                ? "border-indigo-200 bg-indigo-50 text-indigo-800"
                : "border-border bg-card text-muted-foreground",
              current ? "ring-1 ring-indigo-300" : "",
            )}
            aria-current={current ? "step" : undefined}
          >
            <span className="font-mono text-[10px]">{idx + 1}</span>
            <span>{STATUS_LABEL[stage]}</span>
          </li>
        );
      })}
      {status === "approved" ? (
        <li className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-emerald-800">
          Approved
        </li>
      ) : null}
      {status === "rejected" ? (
        <li className="inline-flex items-center gap-1 rounded-full border border-rose-200 bg-rose-50 px-2 py-0.5 text-rose-800">
          Rejected
        </li>
      ) : null}
    </ol>
  );
}
