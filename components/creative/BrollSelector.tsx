"use client";

import { useMemo, useState } from "react";
import { Check, CheckCircle2, ExternalLink, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { formatDuration } from "@/lib/format-time";
import type { BrollClipT } from "@/lib/video-creatives";

/**
 * V2-18: B-roll selector for the `review_each` mode.
 *
 * Renders one row per script segment with a horizontal strip of
 * candidate clips. The operator clicks a clip to select it; clicking
 * the same clip again deselects. Confirming POSTs the chosen array to
 * `/api/creatives/video/:id/broll/pick` and disables the form
 * mid-flight.
 *
 * Inputs:
 *  - `videoCreativeId`: target row.
 *  - `segments`: ordered list of script segments. We render one row
 *    per segment.
 *  - `candidates`: pre-fetched candidate clips per segment. The b-roll
 *    agent is expected to surface up to ~5 per segment.
 *  - `currentPicks`: existing picks (one per segment) — used to
 *    pre-select the operator's last choice.
 *  - `onSaved`: callback invoked after the API call succeeds. The
 *    parent typically refetches.
 *
 * UI state is mode-aware:
 *  - Empty candidates → "B-roll search hasn't run yet" placeholder.
 *  - Saved → green check + a Re-select button.
 */

export type BrollSelectorSegment = {
  idx: number;
  topic: string;
  broll_theme?: string;
};

export type BrollSelectorProps = {
  videoCreativeId: string;
  segments: BrollSelectorSegment[];
  candidates: Array<{ segmentIdx: number; clips: BrollClipT[] }>;
  currentPicks?: BrollClipT[];
  onSaved?: (clips: BrollClipT[]) => void;
};

export function BrollSelector({
  videoCreativeId,
  segments,
  candidates,
  currentPicks,
  onSaved,
}: BrollSelectorProps) {
  // selections: segment_idx → clip_id
  const initial = useMemo<Record<number, string>>(() => {
    const map: Record<number, string> = {};
    for (const p of currentPicks ?? []) {
      map[p.segment_idx] = p.clip_id;
    }
    return map;
  }, [currentPicks]);
  const [selected, setSelected] = useState<Record<number, string>>(initial);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Build a quick segment → candidates map.
  const byIdx = useMemo(() => {
    const map: Record<number, BrollClipT[]> = {};
    for (const c of candidates) {
      map[c.segmentIdx] = c.clips;
    }
    return map;
  }, [candidates]);

  const hasAnyCandidates = candidates.some((c) => c.clips.length > 0);
  const allChosen = segments.every((s) => Boolean(selected[s.idx]));

  if (!hasAnyCandidates) {
    return (
      <div className="rounded-md border border-dashed bg-muted/30 px-3 py-4 text-center text-xs text-muted-foreground">
        B-roll search hasn&apos;t run yet — wait for the agent loop to surface candidates before
        picking.
      </div>
    );
  }

  const toggle = (segmentIdx: number, clipId: string) => {
    setSaved(false);
    setSelected((prev) => {
      const next = { ...prev };
      if (next[segmentIdx] === clipId) {
        delete next[segmentIdx];
      } else {
        next[segmentIdx] = clipId;
      }
      return next;
    });
  };

  const onConfirm = async () => {
    setError(null);
    setSubmitting(true);
    try {
      const picks: BrollClipT[] = segments
        .map((s) => {
          const clipId = selected[s.idx];
          if (!clipId) return null;
          const clips = byIdx[s.idx] ?? [];
          const clip = clips.find((c) => c.clip_id === clipId);
          if (!clip) return null;
          return { ...clip, segment_idx: s.idx };
        })
        .filter((c): c is BrollClipT => c !== null);

      const res = await fetch(
        `/api/creatives/video/${encodeURIComponent(videoCreativeId)}/broll/pick`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ picks }),
        },
      );
      if (!res.ok) {
        let detail = "";
        try {
          const body = (await res.json()) as { error?: string };
          detail = body.error ?? "";
        } catch {
          /* ignore */
        }
        throw new Error(detail || `pick failed: HTTP ${res.status}`);
      }
      setSaved(true);
      onSaved?.(picks);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-3">
      {saved ? (
        <p className="inline-flex items-center gap-1 rounded-md bg-emerald-50 px-2 py-1 text-[11px] text-emerald-800">
          <CheckCircle2 aria-hidden="true" className="h-3.5 w-3.5" />
          Picks saved. The agent loop will continue from here.
        </p>
      ) : null}

      {error ? (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1 text-[11px] text-destructive">
          {error}
        </p>
      ) : null}

      <ol className="space-y-3">
        {segments.map((seg) => {
          const clips = byIdx[seg.idx] ?? [];
          if (clips.length === 0) return null;
          const chosen = selected[seg.idx] ?? null;

          return (
            <li key={seg.idx} className="rounded-md border bg-card px-2.5 py-2">
              <div className="mb-1.5 flex items-baseline gap-2">
                <span className="font-mono text-[10px] text-muted-foreground">
                  Seg {seg.idx + 1}
                </span>
                <span className="text-sm font-medium text-foreground">{seg.topic}</span>
                {seg.broll_theme ? (
                  <span className="text-[11px] text-muted-foreground">· {seg.broll_theme}</span>
                ) : null}
              </div>
              <ul className="grid grid-cols-2 gap-2 md:grid-cols-3 lg:grid-cols-5">
                {clips.map((clip) => {
                  const isChosen = chosen === clip.clip_id;
                  const dur = Math.max(0, clip.out_s - clip.in_s);
                  return (
                    <li key={clip.clip_id}>
                      <button
                        type="button"
                        onClick={() => toggle(seg.idx, clip.clip_id)}
                        className={cn(
                          "group relative w-full overflow-hidden rounded-md border bg-muted text-left transition",
                          isChosen
                            ? "border-indigo-500 ring-1 ring-indigo-300"
                            : "hover:border-foreground/40",
                        )}
                        aria-pressed={isChosen}
                        aria-label={`Pick ${clip.clip_id} for segment ${seg.idx + 1}`}
                      >
                        {clip.thumbnail_url ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={clip.thumbnail_url}
                            alt={clip.theme ?? clip.clip_id}
                            loading="lazy"
                            className="aspect-video w-full object-cover"
                          />
                        ) : (
                          <div className="flex aspect-video w-full items-center justify-center text-[11px] text-muted-foreground">
                            {clip.clip_id}
                          </div>
                        )}
                        {isChosen ? (
                          <span className="absolute right-1 top-1 inline-flex h-5 w-5 items-center justify-center rounded-full bg-indigo-600 text-white">
                            <Check aria-hidden="true" className="h-3 w-3" />
                          </span>
                        ) : null}
                        <div className="flex items-baseline justify-between gap-1 px-1.5 py-1 text-[10px]">
                          <span className="truncate font-mono text-foreground" title={clip.clip_id}>
                            {clip.clip_id}
                          </span>
                          <span className="shrink-0 font-mono text-muted-foreground">
                            {formatDuration(Math.round(dur))}
                          </span>
                        </div>
                        {clip.source_url ? (
                          <a
                            href={clip.source_url}
                            target="_blank"
                            rel="noreferrer noopener"
                            onClick={(e) => e.stopPropagation()}
                            className="absolute bottom-1 right-1 inline-flex items-center gap-0.5 rounded bg-black/60 px-1 text-[9px] text-white"
                            aria-label="Open source"
                          >
                            src
                            <ExternalLink aria-hidden="true" className="h-2.5 w-2.5" />
                          </a>
                        ) : null}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </li>
          );
        })}
      </ol>

      <div className="flex items-center justify-end gap-2">
        <span className="text-[11px] text-muted-foreground">
          {Object.keys(selected).length}/{segments.length} chosen
        </span>
        <Button type="button" size="sm" onClick={onConfirm} disabled={submitting || !allChosen}>
          {submitting ? (
            <>
              <Loader2 aria-hidden="true" className="mr-1 h-3.5 w-3.5 animate-spin" />
              Saving…
            </>
          ) : (
            "Confirm selection"
          )}
        </Button>
      </div>
    </div>
  );
}
