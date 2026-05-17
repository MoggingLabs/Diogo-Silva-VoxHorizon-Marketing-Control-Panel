"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, ImageOff, Loader2, Sparkles } from "lucide-react";

import { StageShell } from "./StageShell";
import { activeTracks, type PipelineTrack } from "@/lib/pipeline/tracks";
import { updatePicks } from "@/lib/pipeline/client";
import type { Pipeline } from "@/lib/pipeline/types";
import {
  CREATIVES_BUCKET as VIDEO_CREATIVES_BUCKET,
  DEFAULT_SIGNED_URL_TTL_S as VIDEO_SIGNED_URL_TTL_S,
  readBrollClips,
  type VideoCreative,
} from "@/lib/video-creatives";
import type { Creative } from "@/lib/creatives";
import { createRealtimeQueue } from "@/lib/realtime-queue";
import { createClient } from "@/lib/supabase/browser";
import { cn } from "@/lib/utils";

const IMAGE_BUCKET = "creatives";
const IMAGE_SIGNED_URL_TTL_S = 3600;

export type StageIdeationProps = {
  pipeline: Pipeline;
  imageBriefId?: string | null;
  videoBriefId?: string | null;
};

/**
 * Ideation stage UI (PF-C-3).
 *
 * Renders a per-track column of cheap variants the worker has produced
 * during ideation. The operator picks ≥1 variant per active track via a
 * checkbox on each card; the gate for "Continue → Review" is met when
 * every active track has at least one pick.
 *
 * Layout:
 *   - One column per active track (image, video, or both depending on
 *     `pipeline.format_choice`). Columns sit side-by-side at lg+ and
 *     stack vertically below — important on mobile where each card is
 *     still useful at 375px.
 *   - Per-track "Picked: X of Y" counter sits in the column header so
 *     the operator can see progress at a glance.
 *   - Continue button uses the shared `StageShell` footer and stays
 *     disabled until the gate is satisfied.
 *
 * Realtime: each column subscribes to its respective table
 * (`creatives` filtered by `brief_id = imageBriefId`, `video_creatives`
 * filtered by `brief_id = videoBriefId`) and renders new rows as they
 * stream in. The pattern is the same as `VariantsGrid` / `VideoVariantsGrid`
 * but stripped of the side-panel / iteration thread that the standalone
 * review surfaces use — ideation is purely a "pick the concepts you
 * want generated for real" step.
 *
 * Picks state:
 *   - Lives in component state as `{ image: Set<string>, video: Set<string> }`.
 *   - Initial value is hydrated from `pipeline.picks` so picks survive
 *     page reloads.
 *   - Each toggle is persisted via `POST /api/pipelines/[id]/picks`. We
 *     update the local set first (optimistic), then POST in the
 *     background. On a network failure we revert and surface an inline
 *     error banner — the user can retry by toggling again.
 */
export function StageIdeation({ pipeline, imageBriefId, videoBriefId }: StageIdeationProps) {
  const router = useRouter();
  const tracks = activeTracks(pipeline.format_choice);

  // Initial picks from the persisted column. We deliberately accept
  // mismatched-track entries here (e.g. a `video` array on an
  // image-only pipeline) without filtering — the API guard will reject
  // an attempt to write them, but visualising what's stored is fine.
  const initialPicks = useMemo(() => {
    const stored = pipeline.picks ?? {};
    return {
      image: new Set<string>(stored.image ?? []),
      video: new Set<string>(stored.video ?? []),
    };
  }, [pipeline.picks]);

  const [picks, setPicks] = useState<{ image: Set<string>; video: Set<string> }>(initialPicks);
  const [advancing, setAdvancing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const togglePick = useCallback(
    async (track: PipelineTrack, creativeId: string) => {
      // Optimistic toggle: update state first, then POST. On failure we
      // revert. We do NOT debounce — each click is a discrete decision
      // and the server merge logic is idempotent.
      const before = picks[track];
      const nextSet = new Set(before);
      if (nextSet.has(creativeId)) {
        nextSet.delete(creativeId);
      } else {
        nextSet.add(creativeId);
      }
      setPicks((p) => ({ ...p, [track]: nextSet }));
      setError(null);

      try {
        await updatePicks(pipeline.id, {
          [track]: Array.from(nextSet),
        });
      } catch (e) {
        // Revert.
        setPicks((p) => ({ ...p, [track]: before }));
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [picks, pipeline.id],
  );

  // Gate: every active track needs ≥1 pick.
  const canContinue = useMemo(() => tracks.every((t) => picks[t].size > 0), [picks, tracks]);

  const handleContinue = useCallback(async () => {
    if (!canContinue || advancing) return;
    setAdvancing(true);
    setError(null);
    try {
      const base = typeof window !== "undefined" ? "" : "";
      const res = await fetch(`${base}/api/pipelines/${encodeURIComponent(pipeline.id)}/advance`, {
        method: "POST",
        cache: "no-store",
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(text.slice(0, 200) || `advance failed (${res.status})`);
      }
      // Server-driven refresh — the page will re-render with status='review'.
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setAdvancing(false);
    }
  }, [canContinue, advancing, pipeline.id, router]);

  // Picks count summary for the subtitle — keeps the header informative
  // when both tracks are active.
  const subtitle = useMemo(() => {
    const parts = tracks.map((t) => {
      const label = t === "image" ? "Image" : "Video";
      return `${label}: ${picks[t].size} picked`;
    });
    return `Select at least one concept per track to continue. ${parts.join(" · ")}`;
  }, [picks, tracks]);

  return (
    <StageShell
      title="Ideation"
      subtitle={subtitle}
      canContinue={canContinue && !advancing}
      continueLabel={advancing ? "Advancing…" : "Continue to Review"}
      onContinue={handleContinue}
      body={
        <div className="flex flex-col gap-6">
          {error ? (
            <div
              role="alert"
              className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              {error}
            </div>
          ) : null}
          <div
            className={cn(
              "grid grid-cols-1 gap-6",
              tracks.length === 2 ? "lg:grid-cols-2" : "lg:grid-cols-1",
            )}
          >
            {tracks.includes("image") ? (
              <ImageTrackColumn
                briefId={imageBriefId ?? null}
                picks={picks.image}
                onTogglePick={(id) => togglePick("image", id)}
              />
            ) : null}
            {tracks.includes("video") ? (
              <VideoTrackColumn
                briefId={videoBriefId ?? null}
                picks={picks.video}
                onTogglePick={(id) => togglePick("video", id)}
              />
            ) : null}
          </div>
        </div>
      }
    />
  );
}

// ---------------------------------------------------------------------------
// Image track
// ---------------------------------------------------------------------------

type TrackHeaderProps = {
  label: string;
  picked: number;
  total: number;
};

function TrackHeader({ label, picked, total }: TrackHeaderProps) {
  return (
    <div className="flex items-baseline justify-between gap-2 border-b border-border pb-2">
      <h3 className="text-sm font-semibold uppercase tracking-wide text-foreground">{label}</h3>
      <span className="text-xs text-muted-foreground">
        Picked: <span className="font-mono text-foreground">{picked}</span> of{" "}
        <span className="font-mono">{total}</span>
      </span>
    </div>
  );
}

type ImageTrackColumnProps = {
  briefId: string | null;
  picks: Set<string>;
  onTogglePick: (id: string) => void;
};

function ImageTrackColumn({ briefId, picks, onTogglePick }: ImageTrackColumnProps) {
  const [creatives, setCreatives] = useState<Creative[]>([]);
  const [signedUrls, setSignedUrls] = useState<Record<string, string | null>>({});
  const pendingSignedUrlsRef = useRef(new Set<string>());

  const fetchSignedUrl = useCallback(async (creativeId: string, filePath: string) => {
    if (pendingSignedUrlsRef.current.has(creativeId)) return;
    pendingSignedUrlsRef.current.add(creativeId);
    try {
      const supabase = createClient();
      const { data, error } = await supabase.storage
        .from(IMAGE_BUCKET)
        .createSignedUrl(filePath, IMAGE_SIGNED_URL_TTL_S);
      if (!error && data?.signedUrl) {
        setSignedUrls((prev) => ({ ...prev, [creativeId]: data.signedUrl }));
      }
    } catch {
      // Fail closed: leave the placeholder tile in place.
    } finally {
      pendingSignedUrlsRef.current.delete(creativeId);
    }
  }, []);

  // Initial fetch — we don't get SSR creatives here (the parent page
  // doesn't pre-fetch ideation variants); we just open the subscription
  // and do an initial select to backfill anything written before the
  // subscription was active.
  useEffect(() => {
    if (!briefId) return;
    let cancelled = false;
    const supabase = createClient();
    void (async () => {
      const { data } = await supabase
        .from("creatives")
        .select("*")
        .eq("brief_id", briefId)
        .order("created_at", { ascending: true });
      if (cancelled || !data) return;
      setCreatives(data);
      for (const c of data) {
        if (c.file_path_supabase) {
          void fetchSignedUrl(c.id, c.file_path_supabase);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [briefId, fetchSignedUrl]);

  useEffect(() => {
    if (!briefId) return;
    const queue = createRealtimeQueue();
    const supabase = createClient();
    const channel = supabase
      .channel(`ideation-creatives:${briefId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "creatives",
          filter: `brief_id=eq.${briefId}`,
        },
        (payload) => {
          const next = payload.new as Creative;
          queue.queue(`insert:${next.id}`, () => {
            setCreatives((prev) => {
              if (prev.some((c) => c.id === next.id)) return prev;
              return [...prev, next];
            });
            if (next.file_path_supabase) {
              void fetchSignedUrl(next.id, next.file_path_supabase);
            }
          });
        },
      )
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "creatives",
          filter: `brief_id=eq.${briefId}`,
        },
        (payload) => {
          const next = payload.new as Creative;
          queue.queue(`update:${next.id}`, () => {
            setCreatives((prev) => prev.map((c) => (c.id === next.id ? next : c)));
            if (next.file_path_supabase && !signedUrls[next.id]) {
              void fetchSignedUrl(next.id, next.file_path_supabase);
            }
          });
        },
      )
      .on(
        "postgres_changes",
        {
          event: "DELETE",
          schema: "public",
          table: "creatives",
          filter: `brief_id=eq.${briefId}`,
        },
        (payload) => {
          const old = payload.old as Partial<Creative>;
          if (!old?.id) return;
          queue.queue(`delete:${old.id}`, () => {
            setCreatives((prev) => prev.filter((c) => c.id !== old.id));
            setSignedUrls((prev) => {
              if (!(old.id! in prev)) return prev;
              const next = { ...prev };
              delete next[old.id!];
              return next;
            });
          });
        },
      )
      .subscribe();

    return () => {
      queue.dispose();
      void supabase.removeChannel(channel);
    };
  }, [briefId, fetchSignedUrl, signedUrls]);

  const sorted = useMemo(
    () =>
      [...creatives].sort(
        (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
      ),
    [creatives],
  );

  return (
    <div className="flex flex-col gap-3">
      <TrackHeader label="Image concepts" picked={picks.size} total={sorted.length} />
      {sorted.length === 0 ? (
        <IdeationEmptyState />
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {sorted.map((c) => (
            <ImagePickCard
              key={c.id}
              creative={c}
              signedUrl={signedUrls[c.id] ?? null}
              picked={picks.has(c.id)}
              onToggle={() => onTogglePick(c.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

type ImagePickCardProps = {
  creative: Creative;
  signedUrl: string | null;
  picked: boolean;
  onToggle: () => void;
};

function ImagePickCard({ creative, signedUrl, picked, onToggle }: ImagePickCardProps) {
  const concept = creative.concept?.trim() || "Untitled concept";
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={picked}
      aria-label={`Pick concept ${concept}`}
      onClick={onToggle}
      className={cn(
        "group relative flex flex-col gap-2 overflow-hidden rounded-md border bg-card text-left shadow-sm",
        "transition-all hover:border-zinc-300 hover:shadow-md",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
        picked ? "border-emerald-400 ring-2 ring-emerald-300" : "border-border",
      )}
    >
      <div className="relative aspect-square w-full overflow-hidden bg-muted/40">
        {signedUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- signed URLs from Supabase Storage need a plain <img>
          <img
            src={signedUrl}
            alt={concept}
            loading="lazy"
            className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.02]"
          />
        ) : (
          <div className="flex h-full w-full flex-col items-center justify-center gap-1 text-muted-foreground">
            <ImageOff aria-hidden="true" className="h-6 w-6" />
            <span className="text-[11px]">No render yet</span>
          </div>
        )}
        <PickIndicator picked={picked} />
      </div>
      <div className="flex flex-col gap-1 px-3 pb-3 pt-1">
        <span className="line-clamp-2 text-sm font-medium text-foreground" title={concept}>
          {concept}
        </span>
        <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
          <span className="font-mono">{creative.ratio ?? "—"}</span>
          <span className="font-mono">{creative.version}</span>
        </div>
      </div>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Video track
// ---------------------------------------------------------------------------

type VideoTrackColumnProps = {
  briefId: string | null;
  picks: Set<string>;
  onTogglePick: (id: string) => void;
};

function VideoTrackColumn({ briefId, picks, onTogglePick }: VideoTrackColumnProps) {
  const [creatives, setCreatives] = useState<VideoCreative[]>([]);
  // Per-creative cached script excerpt — populated lazily from the
  // `script_path` text stored in Supabase Storage. We don't gate the
  // card render on it: the broll-plan summary alone is useful, and
  // the script blob trickles in once the file becomes available.
  const [scriptExcerpts, setScriptExcerpts] = useState<Record<string, string>>({});
  const pendingScriptsRef = useRef(new Set<string>());

  const fetchScriptExcerpt = useCallback(async (creativeId: string, scriptPath: string) => {
    if (pendingScriptsRef.current.has(creativeId)) return;
    pendingScriptsRef.current.add(creativeId);
    try {
      const supabase = createClient();
      const { data, error } = await supabase.storage
        .from(VIDEO_CREATIVES_BUCKET)
        .createSignedUrl(scriptPath, VIDEO_SIGNED_URL_TTL_S);
      if (!error && data?.signedUrl) {
        const res = await fetch(data.signedUrl, { cache: "no-store" });
        if (res.ok) {
          const text = await res.text();
          // Trim to ~240 chars for the card preview; the side panel /
          // review stage shows the full script.
          const excerpt = text.replace(/\s+/g, " ").trim().slice(0, 240);
          setScriptExcerpts((prev) => ({ ...prev, [creativeId]: excerpt }));
        }
      }
    } catch {
      // Fail closed; the placeholder copy stays.
    } finally {
      pendingScriptsRef.current.delete(creativeId);
    }
  }, []);

  useEffect(() => {
    if (!briefId) return;
    let cancelled = false;
    const supabase = createClient();
    void (async () => {
      const { data } = await supabase
        .from("video_creatives")
        .select("*")
        .eq("brief_id", briefId)
        .order("created_at", { ascending: true });
      if (cancelled || !data) return;
      setCreatives(data);
      for (const c of data) {
        if (c.script_path) {
          void fetchScriptExcerpt(c.id, c.script_path);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [briefId, fetchScriptExcerpt]);

  useEffect(() => {
    if (!briefId) return;
    const queue = createRealtimeQueue();
    const supabase = createClient();
    const channel = supabase
      .channel(`ideation-video-creatives:${briefId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "video_creatives",
          filter: `brief_id=eq.${briefId}`,
        },
        (payload) => {
          const next = payload.new as VideoCreative;
          queue.queue(`insert:${next.id}`, () => {
            setCreatives((prev) => {
              if (prev.some((c) => c.id === next.id)) return prev;
              return [...prev, next];
            });
            if (next.script_path) {
              void fetchScriptExcerpt(next.id, next.script_path);
            }
          });
        },
      )
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "video_creatives",
          filter: `brief_id=eq.${briefId}`,
        },
        (payload) => {
          const next = payload.new as VideoCreative;
          queue.queue(`update:${next.id}`, () => {
            setCreatives((prev) => prev.map((c) => (c.id === next.id ? next : c)));
            if (next.script_path && !scriptExcerpts[next.id]) {
              void fetchScriptExcerpt(next.id, next.script_path);
            }
          });
        },
      )
      .on(
        "postgres_changes",
        {
          event: "DELETE",
          schema: "public",
          table: "video_creatives",
          filter: `brief_id=eq.${briefId}`,
        },
        (payload) => {
          const old = payload.old as Partial<VideoCreative>;
          if (!old?.id) return;
          queue.queue(`delete:${old.id}`, () => {
            setCreatives((prev) => prev.filter((c) => c.id !== old.id));
            setScriptExcerpts((prev) => {
              if (!(old.id! in prev)) return prev;
              const next = { ...prev };
              delete next[old.id!];
              return next;
            });
          });
        },
      )
      .subscribe();

    return () => {
      queue.dispose();
      void supabase.removeChannel(channel);
    };
  }, [briefId, fetchScriptExcerpt, scriptExcerpts]);

  const sorted = useMemo(
    () =>
      [...creatives].sort(
        (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
      ),
    [creatives],
  );

  return (
    <div className="flex flex-col gap-3">
      <TrackHeader label="Video concepts" picked={picks.size} total={sorted.length} />
      {sorted.length === 0 ? (
        <IdeationEmptyState />
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {sorted.map((c) => (
            <VideoPickCard
              key={c.id}
              creative={c}
              scriptExcerpt={scriptExcerpts[c.id] ?? null}
              picked={picks.has(c.id)}
              onToggle={() => onTogglePick(c.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

type VideoPickCardProps = {
  creative: VideoCreative;
  scriptExcerpt: string | null;
  picked: boolean;
  onToggle: () => void;
};

function VideoPickCard({ creative, scriptExcerpt, picked, onToggle }: VideoPickCardProps) {
  const brollClips = readBrollClips(creative.broll_clips);
  // Summarise the b-roll plan: list themes when present, otherwise show
  // the segment count so the operator has *something* to differentiate
  // concepts before previews are ready.
  const brollSummary = useMemo(() => {
    if (brollClips.length === 0) return "No b-roll plan yet.";
    const themes = brollClips
      .map((c) => c.theme)
      .filter((t): t is string => Boolean(t))
      .slice(0, 4);
    if (themes.length > 0) {
      return `B-roll: ${themes.join(" · ")}${themes.length < brollClips.length ? "…" : ""}`;
    }
    return `B-roll plan: ${brollClips.length} segment${brollClips.length === 1 ? "" : "s"}`;
  }, [brollClips]);

  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={picked}
      aria-label={`Pick video concept v${creative.version}`}
      onClick={onToggle}
      className={cn(
        "group relative flex flex-col gap-2 overflow-hidden rounded-md border bg-card p-3 text-left shadow-sm",
        "transition-all hover:border-zinc-300 hover:shadow-md",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
        picked ? "border-emerald-400 ring-2 ring-emerald-300" : "border-border",
      )}
    >
      <div className="absolute right-2 top-2">
        <PickIndicator picked={picked} />
      </div>
      <div className="flex items-baseline justify-between gap-2 pr-8">
        <span className="text-sm font-medium text-foreground">Concept v{creative.version}</span>
        <span className="font-mono text-[11px] text-muted-foreground">{creative.status}</span>
      </div>
      <p className="line-clamp-4 text-xs text-muted-foreground">
        {scriptExcerpt ?? "Script pending — Ekko is still drafting this concept."}
      </p>
      <p className="rounded border border-border bg-muted/40 px-2 py-1 text-[11px] text-foreground">
        {brollSummary}
      </p>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

function PickIndicator({ picked }: { picked: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "absolute right-2 top-2 inline-flex h-6 w-6 items-center justify-center rounded-full border shadow",
        picked
          ? "border-emerald-500 bg-emerald-500 text-white"
          : "border-zinc-300 bg-white/90 text-transparent",
      )}
    >
      <Check className="h-4 w-4" />
    </span>
  );
}

function IdeationEmptyState() {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-md border border-dashed bg-muted/30 px-6 py-12 text-center">
      <div className="relative">
        <Sparkles aria-hidden="true" className="h-7 w-7 text-muted-foreground" />
        <Loader2
          aria-hidden="true"
          className="absolute -right-1 -top-1 h-4 w-4 animate-spin text-muted-foreground"
        />
      </div>
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">Ekko is sketching concepts…</p>
        <p className="text-xs text-muted-foreground">
          Picks: <span className="font-mono">0</span>. Variants stream in as they&apos;re ready.
        </p>
      </div>
    </div>
  );
}

// Re-export for callers that need the props type.
export type StageIdeationComponent = typeof StageIdeation;
