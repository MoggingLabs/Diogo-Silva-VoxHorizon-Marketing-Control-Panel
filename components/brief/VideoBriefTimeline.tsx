"use client";

import * as React from "react";

import { useRealtimeStream } from "@/hooks/useRealtimeStream";

interface EventRow {
  id: string;
  kind: string;
  created_at: string;
  payload: Record<string, unknown> | null;
}

export interface VideoBriefTimelineProps {
  videoBriefId: string;
  initialEvents: EventRow[];
}

/**
 * Realtime-backed event timeline for a single video brief.
 *
 * Starts from a server-fetched snapshot, then subscribes to INSERTs on the
 * `events` table filtered to this brief's `(ref_table, ref_id)`. The
 * `events` table is intentionally excluded from the global realtime
 * publication (it's high-volume) — Supabase still allows postgres_changes
 * subscriptions with explicit filters, so we use that path here.
 */
export function VideoBriefTimeline({ videoBriefId, initialEvents }: VideoBriefTimelineProps) {
  const [events, setEvents] = React.useState<EventRow[]>(initialEvents);

  useRealtimeStream(
    React.useMemo(
      () => [
        {
          table: "events",
          event: "INSERT" as const,
          filter: `ref_id=eq.${videoBriefId}`,
          callback: (payload) => {
            const next = payload.new as unknown as EventRow;
            if (next.id == null) return;
            setEvents((prev) => (prev.some((e) => e.id === next.id) ? prev : [next, ...prev]));
          },
        },
      ],
      [videoBriefId],
    ),
  );

  if (events.length === 0) {
    return <p className="text-sm text-muted-foreground">No events yet.</p>;
  }

  return (
    <ol className="flex flex-col gap-3">
      {events.map((e) => (
        <li
          key={e.id}
          className="flex flex-col gap-1 rounded-md border border-input bg-background p-3"
        >
          <div className="flex items-center justify-between">
            <span className="font-mono text-xs text-muted-foreground">
              {new Date(e.created_at).toLocaleString()}
            </span>
            <span className="rounded-full bg-secondary px-2 py-0.5 text-xs font-medium text-secondary-foreground">
              {e.kind}
            </span>
          </div>
          {e.payload && Object.keys(e.payload).length > 0 && (
            <pre className="overflow-x-auto rounded-sm bg-muted/40 p-2 text-xs">
              {JSON.stringify(e.payload, null, 2)}
            </pre>
          )}
        </li>
      ))}
    </ol>
  );
}
