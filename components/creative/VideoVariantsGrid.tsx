"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { Route } from "next";

import { createRealtimeQueue } from "@/lib/realtime-queue";
import { createClient } from "@/lib/supabase/browser";
import {
  CREATIVES_BUCKET,
  DEFAULT_SIGNED_URL_TTL_S,
  type VideoCreative,
} from "@/lib/video-creatives";
import type { VideoBrief } from "@/lib/video-briefs";

import { VideoCreativeCard } from "./VideoCreativeCard";
import { VideoSidePanel } from "./VideoSidePanel";

/**
 * Three signed URLs per video creative: the captioned MP4 (preferred
 * preview), the composed MP4 (fallback while captioning is still pending),
 * and the voiceover audio. Kept per-id in a flat dict so Realtime updates
 * can patch in place.
 */
type UrlBundle = {
  captioned: string | null;
  composed: string | null;
  voiceover: string | null;
};

const EMPTY_BUNDLE: UrlBundle = {
  captioned: null,
  composed: null,
  voiceover: null,
};

export type VideoVariantsGridProps = {
  brief: VideoBrief;
  initialCreatives: VideoCreative[];
  initialSignedUrls: Record<string, UrlBundle>;
  selectedId: string | null;
};

/**
 * Video variants grid: one card per creative tied to the brief, opens the
 * side panel on click, and stays live via Supabase Realtime.
 *
 * Architecture mirrors the image side (`VariantsGrid.tsx`):
 *  - SSR hands us `initialCreatives` + a map of `signedUrls` resolved
 *    server-side with the admin client. We trust that for first paint.
 *  - The selected creative is mirrored in the URL via `?creative=<id>`.
 *  - Realtime: a single channel listens to INSERT/UPDATE/DELETE on
 *    `video_creatives` filtered by this brief; we reconcile state in
 *    place so the page never needs a hard refresh. When a row gains a
 *    new file path (e.g. the captioning stage completes), we lazily
 *    fetch the matching signed URL on the client.
 */
export function VideoVariantsGrid({
  brief,
  initialCreatives,
  initialSignedUrls,
  selectedId,
}: VideoVariantsGridProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [creatives, setCreatives] = useState<VideoCreative[]>(initialCreatives);
  const [signedUrls, setSignedUrls] = useState<Record<string, UrlBundle>>(initialSignedUrls);
  const pendingRef = useRef(new Set<string>());

  // Keep state in sync when the server re-renders (e.g. after router.refresh()).
  useEffect(() => {
    setCreatives(initialCreatives);
  }, [initialCreatives]);
  useEffect(() => {
    setSignedUrls((prev) => ({ ...prev, ...initialSignedUrls }));
  }, [initialSignedUrls]);

  /**
   * Resolve any missing signed URLs for a creative. Only fetches paths
   * we don't already have a URL for — keeps the call count bounded
   * even on chatty pipelines.
   */
  const fetchMissingUrls = useCallback(
    async (creative: VideoCreative) => {
      const id = creative.id;
      // Track in-flight calls so concurrent updates don't double-fetch.
      const key = id;
      if (pendingRef.current.has(key)) return;

      const current = signedUrls[id] ?? EMPTY_BUNDLE;
      const needsCaptioned = !current.captioned && creative.captioned_path;
      const needsComposed = !current.composed && creative.composed_path;
      const needsVoiceover = !current.voiceover && creative.voiceover_path;
      if (!needsCaptioned && !needsComposed && !needsVoiceover) return;

      pendingRef.current.add(key);
      try {
        const supabase = createClient();
        const results = await Promise.all([
          needsCaptioned && creative.captioned_path
            ? supabase.storage
                .from(CREATIVES_BUCKET)
                .createSignedUrl(creative.captioned_path, DEFAULT_SIGNED_URL_TTL_S)
            : Promise.resolve({ data: null, error: null }),
          needsComposed && creative.composed_path
            ? supabase.storage
                .from(CREATIVES_BUCKET)
                .createSignedUrl(creative.composed_path, DEFAULT_SIGNED_URL_TTL_S)
            : Promise.resolve({ data: null, error: null }),
          needsVoiceover && creative.voiceover_path
            ? supabase.storage
                .from(CREATIVES_BUCKET)
                .createSignedUrl(creative.voiceover_path, DEFAULT_SIGNED_URL_TTL_S)
            : Promise.resolve({ data: null, error: null }),
        ]);
        const [captionedRes, composedRes, voiceoverRes] = results;
        setSignedUrls((prev) => {
          const existing = prev[id] ?? EMPTY_BUNDLE;
          const next: UrlBundle = {
            captioned: captionedRes.data?.signedUrl ?? existing.captioned,
            composed: composedRes.data?.signedUrl ?? existing.composed,
            voiceover: voiceoverRes.data?.signedUrl ?? existing.voiceover,
          };
          return { ...prev, [id]: next };
        });
      } catch {
        // Fail closed; the placeholder tile remains in place.
      } finally {
        pendingRef.current.delete(key);
      }
    },
    [signedUrls],
  );

  useEffect(() => {
    // Video pipeline writes a chatty stream of `video_creatives`
    // updates (script → voiceover → broll → composed → captioned).
    // Debounce them so each pipeline transition is one render.
    const queue = createRealtimeQueue();
    const supabase = createClient();
    const channel = supabase
      .channel(`video-creatives:${brief.id}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "video_creatives",
          filter: `brief_id=eq.${brief.id}`,
        },
        (payload) => {
          const next = payload.new as VideoCreative;
          queue.queue(`insert:${next.id}`, () => {
            setCreatives((prev) => {
              if (prev.some((c) => c.id === next.id)) return prev;
              return [...prev, next];
            });
            void fetchMissingUrls(next);
          });
        },
      )
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "video_creatives",
          filter: `brief_id=eq.${brief.id}`,
        },
        (payload) => {
          const next = payload.new as VideoCreative;
          queue.queue(`update:${next.id}`, () => {
            setCreatives((prev) => prev.map((c) => (c.id === next.id ? next : c)));
            void fetchMissingUrls(next);
          });
        },
      )
      .on(
        "postgres_changes",
        {
          event: "DELETE",
          schema: "public",
          table: "video_creatives",
          filter: `brief_id=eq.${brief.id}`,
        },
        (payload) => {
          const old = payload.old as Partial<VideoCreative>;
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
  }, [brief.id, fetchMissingUrls]);

  const sorted = useMemo(
    () =>
      [...creatives].sort(
        (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
      ),
    [creatives],
  );

  const updateSelection = useCallback(
    (id: string | null) => {
      const params = new URLSearchParams(searchParams?.toString() ?? "");
      if (id) {
        params.set("creative", id);
      } else {
        params.delete("creative");
      }
      const qs = params.toString();
      // Cast through `Route` because typedRoutes is strict — at runtime the
      // pathname is always /creatives/video/[briefId].
      const target = (qs ? `${pathname}?${qs}` : pathname) as Route;
      router.replace(target, { scroll: false });
    },
    [pathname, router, searchParams],
  );

  const selectedCreative = useMemo(
    () => (selectedId ? (sorted.find((c) => c.id === selectedId) ?? null) : null),
    [sorted, selectedId],
  );

  const selectedBundle: UrlBundle = selectedCreative
    ? (signedUrls[selectedCreative.id] ?? EMPTY_BUNDLE)
    : EMPTY_BUNDLE;

  if (sorted.length === 0) {
    return (
      <div className="rounded-md border border-dashed bg-muted/30 px-6 py-12 text-center">
        <p className="text-sm font-medium text-foreground">No video creatives yet.</p>
        <p className="mt-1 text-xs text-muted-foreground">
          The agent will produce them once the brief is approved and the agent loop is wired.
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
        {sorted.map((c) => {
          const bundle = signedUrls[c.id] ?? EMPTY_BUNDLE;
          // The card prefers the captioned URL; fall back to the composed
          // URL when captioning hasn't run yet so operators can preview
          // mid-pipeline renders.
          const cardUrl = bundle.captioned ?? bundle.composed;
          return (
            <VideoCreativeCard
              key={c.id}
              creative={c}
              signedUrl={cardUrl}
              active={selectedId === c.id}
              onSelect={updateSelection}
            />
          );
        })}
      </div>

      <VideoSidePanel
        creative={selectedCreative}
        brief={brief}
        captionedUrl={selectedBundle.captioned}
        composedUrl={selectedBundle.composed}
        voiceoverUrl={selectedBundle.voiceover}
        open={selectedId !== null}
        onOpenChange={(open) => {
          if (!open) updateSelection(null);
        }}
      />
    </>
  );
}
