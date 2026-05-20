"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { Route } from "next";
import { ImageIcon } from "lucide-react";

import { EmptyState } from "@/components/EmptyState";
import { createRealtimeQueue } from "@/lib/realtime-queue";
import { useRealtimeStream } from "@/hooks/useRealtimeStream";
import { signStoragePath } from "@/lib/realtime/client-data";
import type { Creative } from "@/lib/creatives";

import { CreativeCard } from "./CreativeCard";
import { SidePanel } from "./SidePanel";

export type VariantsGridProps = {
  briefId: string;
  initialCreatives: Creative[];
  initialSignedUrls: Record<string, string | null>;
  selectedId: string | null;
};

/**
 * Variants grid: renders one card per creative tied to the brief, opens
 * the side panel on click, and stays live via Supabase Realtime.
 *
 * Architecture decisions:
 *  - SSR hands us `initialCreatives` + a map of `signedUrls` (resolved
 *    server-side with the admin client). We trust that map for the
 *    first paint; for rows that arrive via Realtime we lazily fetch a
 *    signed URL on the client.
 *  - The selected creative is mirrored in the URL via the `creative`
 *    search param. `router.replace` keeps it shareable without pushing
 *    history entries on every click.
 *  - Realtime: a single channel listens to INSERT/UPDATE/DELETE on
 *    `creatives` filtered by this brief; we reconcile state in place
 *    so the page never needs a hard refresh.
 */
export function VariantsGrid({
  briefId,
  initialCreatives,
  initialSignedUrls,
  selectedId,
}: VariantsGridProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [creatives, setCreatives] = useState<Creative[]>(initialCreatives);
  const [signedUrls, setSignedUrls] = useState<Record<string, string | null>>(initialSignedUrls);
  const pendingSignedUrlsRef = useRef(new Set<string>());
  // Mirror signedUrls in a ref so the realtime UPDATE handler can read the
  // latest map without the listener set (and thus the SSE connection)
  // re-subscribing on every URL change.
  const signedUrlsRef = useRef(signedUrls);
  signedUrlsRef.current = signedUrls;

  // Keep state in sync when the server re-renders (e.g. after router.refresh()).
  useEffect(() => {
    setCreatives(initialCreatives);
  }, [initialCreatives]);
  useEffect(() => {
    setSignedUrls((prev) => ({ ...prev, ...initialSignedUrls }));
  }, [initialSignedUrls]);

  const fetchSignedUrl = useCallback(async (creativeId: string, filePath: string) => {
    if (pendingSignedUrlsRef.current.has(creativeId)) return;
    pendingSignedUrlsRef.current.add(creativeId);
    try {
      // Signed URLs are minted server-side (service-role) now that the anon
      // key can't reach Storage under RLS deny-all.
      const signedUrl = await signStoragePath("creatives", filePath, 3600);
      if (signedUrl) {
        setSignedUrls((prev) => ({ ...prev, [creativeId]: signedUrl }));
      }
    } catch {
      // Fail closed: leave the placeholder tile in place.
    } finally {
      pendingSignedUrlsRef.current.delete(creativeId);
    }
  }, []);

  // Debounce realtime invalidations: the worker can write several `creatives`
  // rows in a tight burst (e.g. four-variant fan-out), and we don't want each
  // row to trigger its own React render. INSERT/UPDATE/DELETE handlers stage
  // state mutations into the queue and the 200ms flush runs them in a single
  // batch. Realtime now flows through the server-side SSE relay.
  const queueRef = useRef(createRealtimeQueue());
  useEffect(() => {
    const queue = queueRef.current;
    return () => queue.dispose();
  }, []);

  const filter = `brief_id=eq.${briefId}`;
  useRealtimeStream(
    useMemo(
      () => [
        {
          table: "creatives",
          event: "INSERT" as const,
          filter,
          callback: (payload) => {
            const next = payload.new as unknown as Creative;
            queueRef.current.queue(`insert:${next.id}`, () => {
              setCreatives((prev) => {
                if (prev.some((c) => c.id === next.id)) return prev;
                return [...prev, next];
              });
              if (next.file_path_supabase) {
                void fetchSignedUrl(next.id, next.file_path_supabase);
              }
            });
          },
        },
        {
          table: "creatives",
          event: "UPDATE" as const,
          filter,
          callback: (payload) => {
            const next = payload.new as unknown as Creative;
            queueRef.current.queue(`update:${next.id}`, () => {
              setCreatives((prev) => prev.map((c) => (c.id === next.id ? next : c)));
              // If the file path changed and we don't have a URL yet, fetch one.
              if (next.file_path_supabase && !signedUrlsRef.current[next.id]) {
                void fetchSignedUrl(next.id, next.file_path_supabase);
              }
            });
          },
        },
        {
          table: "creatives",
          event: "DELETE" as const,
          filter,
          callback: (payload) => {
            const old = payload.old as Partial<Creative>;
            if (!old?.id) return;
            queueRef.current.queue(`delete:${old.id}`, () => {
              setCreatives((prev) => prev.filter((c) => c.id !== old.id));
              setSignedUrls((prev) => {
                if (!(old.id! in prev)) return prev;
                const next = { ...prev };
                delete next[old.id!];
                return next;
              });
            });
          },
        },
      ],
      [filter, fetchSignedUrl],
    ),
  );

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
      // The pathname is always `/creatives/[briefId]` at runtime, but
      // `usePathname()` returns a plain string. typedRoutes is strict, so
      // we cast through `Route` once for the navigation call.
      const target = (qs ? `${pathname}?${qs}` : pathname) as Route;
      router.replace(target, { scroll: false });
    },
    [pathname, router, searchParams],
  );

  const selectedCreative = useMemo(
    () => (selectedId ? (sorted.find((c) => c.id === selectedId) ?? null) : null),
    [sorted, selectedId],
  );

  if (sorted.length === 0) {
    return (
      <EmptyState
        icon={<ImageIcon className="h-8 w-8" aria-hidden="true" />}
        title="No creatives yet"
        description="Once the worker renders variants for this brief, they'll show up here in real time."
      />
    );
  }

  return (
    <>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
        {sorted.map((c) => (
          <CreativeCard
            key={c.id}
            creative={c}
            signedUrl={signedUrls[c.id] ?? null}
            active={selectedId === c.id}
            onSelect={updateSelection}
          />
        ))}
      </div>

      <SidePanel
        creative={selectedCreative}
        signedUrl={selectedCreative ? (signedUrls[selectedCreative.id] ?? null) : null}
        open={selectedId !== null}
        onOpenChange={(open) => {
          if (!open) updateSelection(null);
        }}
      />
    </>
  );
}
