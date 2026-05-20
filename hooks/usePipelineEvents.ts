"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { createRealtimeQueue } from "@/lib/realtime-queue";
import type { PipelineEvent } from "@/lib/pipeline/types";
import { useRealtimeStream } from "@/hooks/useRealtimeStream";

/**
 * Subscribe to `pipeline_events` for a single pipeline and return the
 * chronologically-ordered event stream as React state.
 *
 * Issue: #195 (PF-E-3).
 *
 * Hydration: the caller hands us the initial event list (server-side
 * fetch via `/api/pipelines/[id]`). We seed state from that list so the
 * first paint is correct, then open a Supabase Realtime channel filtered
 * by `pipeline_id`. Inserts land via the realtime-queue debounce
 * (200 ms) so a burst of worker writes — e.g. 8 image renders firing
 * within a second during the generation stage — collapses into a single
 * React re-render.
 *
 * Append-only contract: rows are never deleted in production, so we
 * only handle INSERT events. UPDATE / DELETE handlers exist as
 * defensive paths so a hand-edited row doesn't desync the UI.
 *
 * Cleanup: the channel is removed and the queue disposed on unmount;
 * a stale subscription would survive page navigation and leak memory.
 */
export function usePipelineEvents(
  pipelineId: string,
  initialEvents: PipelineEvent[],
): PipelineEvent[] {
  const [events, setEvents] = useState<PipelineEvent[]>(() => sortChronologically(initialEvents));

  // Keep the latest events list available to the realtime callback
  // without restarting the effect on every state change. The effect
  // depends only on `pipelineId`, so the subscription survives parent
  // re-renders.
  const eventsRef = useRef(events);
  eventsRef.current = events;

  // Re-seed state whenever the caller hands us a new initial list. The
  // server component re-fetches on `router.refresh()` and re-renders
  // us with a fresh prop; without this we'd ignore the new SSR data
  // and continue showing the older subscription-only feed.
  useEffect(() => {
    setEvents(sortChronologically(initialEvents));
  }, [initialEvents]);

  // Per-component debounce queue, disposed on unmount. Realtime now flows
  // through the server-side SSE relay (`/api/realtime`).
  const queueRef = useRef(createRealtimeQueue());
  useEffect(() => {
    const queue = queueRef.current;
    return () => queue.dispose();
  }, []);

  const filter = `pipeline_id=eq.${pipelineId}`;
  useRealtimeStream(
    useMemo(
      () =>
        pipelineId
          ? [
              {
                table: "pipeline_events",
                event: "INSERT" as const,
                filter,
                callback: (payload) => {
                  const next = payload.new as unknown as PipelineEvent | undefined;
                  if (!next?.id) return;
                  // Debounce by event id: a duplicate notification for the
                  // same row collapses into one queued callback.
                  queueRef.current.queue(`insert:${next.id}`, () => {
                    setEvents((prev) => {
                      // Dedupe — the initial fetch may overlap with realtime
                      // notifications if the subscription opens before the
                      // server response is rendered.
                      if (prev.some((e) => e.id === next.id)) return prev;
                      return appendChronologically(prev, next);
                    });
                  });
                },
              },
              {
                table: "pipeline_events",
                event: "UPDATE" as const,
                filter,
                callback: (payload) => {
                  const next = payload.new as unknown as PipelineEvent | undefined;
                  if (!next?.id) return;
                  queueRef.current.queue(`update:${next.id}`, () => {
                    setEvents((prev) => {
                      const idx = prev.findIndex((e) => e.id === next.id);
                      if (idx === -1) return appendChronologically(prev, next);
                      const updated = [...prev];
                      updated[idx] = next;
                      return updated;
                    });
                  });
                },
              },
              {
                table: "pipeline_events",
                event: "DELETE" as const,
                filter,
                callback: (payload) => {
                  const old = payload.old as Partial<PipelineEvent> | undefined;
                  const id = old?.id;
                  if (!id) return;
                  queueRef.current.queue(`delete:${id}`, () => {
                    setEvents((prev) => prev.filter((e) => e.id !== id));
                  });
                },
              },
            ]
          : [],
      [pipelineId, filter],
    ),
  );

  return events;
}

/**
 * Stable chronological sort (oldest first). `pipeline_events.created_at`
 * is timestamp-only — events written in the same statement share the
 * timestamp — so we fall back to `id` for a stable tiebreak. UUIDv4 ids
 * don't carry time information, but a consistent secondary key keeps
 * the React diff stable across re-renders.
 */
function sortChronologically(events: PipelineEvent[]): PipelineEvent[] {
  const sorted = [...events];
  sorted.sort(compareEvents);
  return sorted;
}

function compareEvents(a: PipelineEvent, b: PipelineEvent): number {
  if (a.created_at === b.created_at) return a.id.localeCompare(b.id);
  return a.created_at < b.created_at ? -1 : 1;
}

/**
 * Append an event in chronological position. For the typical "newest
 * event from realtime" case this is O(1) — the new event sorts at the
 * end. We still binary-skip backwards to keep correctness when the
 * server replays an out-of-order batch (e.g. after a brief
 * disconnect).
 */
function appendChronologically(events: PipelineEvent[], next: PipelineEvent): PipelineEvent[] {
  if (events.length === 0) return [next];
  const last = events[events.length - 1]!;
  if (compareEvents(last, next) <= 0) {
    return [...events, next];
  }
  return sortChronologically([...events, next]);
}
