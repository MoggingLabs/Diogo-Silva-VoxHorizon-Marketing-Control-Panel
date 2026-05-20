"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import { useRealtimeStream } from "@/hooks/useRealtimeStream";
import type { Database } from "@/lib/supabase/types.gen";

type EventRow = Pick<
  Database["public"]["Tables"]["events"]["Row"],
  "id" | "kind" | "created_at" | "payload"
>;

/** Pretty-print an event kind for the operator UI. */
function eventLabel(kind: string): string {
  switch (kind) {
    case "launch_package_posted":
      return "Launch posted";
    case "launch_package_failed":
      return "Pre-flight failed";
    case "launch_package_decided":
      return "Decision recorded";
    case "video_launch_package_posted":
      return "Launch posted";
    case "video_launch_package_failed":
      return "Pre-flight failed";
    case "video_launch_package_decided":
      return "Decision recorded";
    default:
      return kind;
  }
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export interface LaunchTimelineProps {
  launchId: string;
  /** Which table this timeline tracks for realtime updates. */
  table?: "launch_packages" | "video_launch_packages";
  initialEvents: EventRow[];
}

/**
 * Append-only timeline of ``events`` for a single launch package.
 *
 * Pattern mirrors ``<BriefTimeline />``: the `events` table is NOT on the
 * realtime publication, so we instead subscribe to UPDATEs on the launch
 * package itself and call ``router.refresh()`` whenever the row changes
 * — that re-fetches both the launch and its events server-side.
 */
export function LaunchTimeline({
  launchId,
  table = "launch_packages",
  initialEvents,
}: LaunchTimelineProps) {
  const router = useRouter();
  const [events, setEvents] = useState<EventRow[]>(initialEvents);

  useEffect(() => {
    setEvents(initialEvents);
  }, [initialEvents]);

  useRealtimeStream(
    useMemo(
      () => [
        {
          table,
          event: "UPDATE" as const,
          filter: `id=eq.${launchId}`,
          callback: () => router.refresh(),
        },
      ],
      [launchId, router, table],
    ),
  );

  const sorted = useMemo(
    () =>
      [...events].sort(
        (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
      ),
    [events],
  );

  if (sorted.length === 0) {
    return <p className="text-sm text-muted-foreground">No events yet.</p>;
  }

  return (
    <ol className="space-y-3">
      {sorted.map((event) => {
        const payload =
          event.payload && typeof event.payload === "object"
            ? (event.payload as Record<string, unknown>)
            : null;
        const decisionNote =
          payload && typeof payload.notes === "string" && payload.notes.trim().length > 0
            ? payload.notes
            : null;
        const decision = payload && typeof payload.decision === "string" ? payload.decision : null;
        return (
          <li key={event.id} className="rounded-md border bg-card px-3 py-2 text-sm shadow-sm">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="font-medium">
                {eventLabel(event.kind)}
                {decision ? (
                  <span className="ml-2 font-mono text-xs uppercase text-muted-foreground">
                    {decision}
                  </span>
                ) : null}
              </span>
              <span className="text-xs text-muted-foreground">{formatDate(event.created_at)}</span>
            </div>
            {decisionNote ? (
              <p className="mt-1 whitespace-pre-wrap text-muted-foreground">{decisionNote}</p>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
