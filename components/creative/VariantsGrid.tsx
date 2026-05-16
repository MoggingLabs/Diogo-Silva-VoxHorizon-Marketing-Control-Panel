"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { Route } from "next";

import { createClient } from "@/lib/supabase/browser";
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
      const supabase = createClient();
      const { data, error } = await supabase.storage
        .from("creatives")
        .createSignedUrl(filePath, 3600);
      if (!error && data?.signedUrl) {
        setSignedUrls((prev) => ({ ...prev, [creativeId]: data.signedUrl }));
      }
    } catch {
      // Fail closed: leave the placeholder tile in place.
    } finally {
      pendingSignedUrlsRef.current.delete(creativeId);
    }
  }, []);

  useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel(`creatives:${briefId}`)
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
          setCreatives((prev) => {
            if (prev.some((c) => c.id === next.id)) return prev;
            return [...prev, next];
          });
          if (next.file_path_supabase) {
            void fetchSignedUrl(next.id, next.file_path_supabase);
          }
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
          setCreatives((prev) => prev.map((c) => (c.id === next.id ? next : c)));
          // If the file path changed and we don't have a URL yet, fetch one.
          if (next.file_path_supabase && !signedUrls[next.id]) {
            void fetchSignedUrl(next.id, next.file_path_supabase);
          }
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
          setCreatives((prev) => prev.filter((c) => c.id !== old.id));
          setSignedUrls((prev) => {
            if (!(old.id! in prev)) return prev;
            const next = { ...prev };
            delete next[old.id!];
            return next;
          });
        },
      )
      .subscribe();

    return () => {
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
      <div className="rounded-md border border-dashed bg-muted/30 px-6 py-12 text-center">
        <p className="text-sm font-medium text-foreground">No creatives yet</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Once the worker renders variants for this brief, they&apos;ll show up here in real time.
        </p>
      </div>
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
