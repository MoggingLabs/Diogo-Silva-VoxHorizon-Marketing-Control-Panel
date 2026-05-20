"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import { useRealtimeStream } from "@/hooks/useRealtimeStream";
import type { EventRow } from "@/lib/briefs";

/**
 * Pretty-prints an event kind for the operator UI. Falls back to the raw
 * kind when no friendly label is known so new event kinds remain visible.
 */
function eventLabel(kind: string): string {
  switch (kind) {
    case "brief_created":
      return "Brief created";
    case "brief_draft_to_posted":
      return "Posted for approval";
    case "brief_posted_to_draft":
      return "Returned to draft";
    case "brief_posted_to_approved":
      return "Approved";
    case "brief_posted_to_approved_with_changes":
      return "Approved with changes";
    case "brief_posted_to_rejected":
      return "Rejected";
    case "brief_rejected_to_draft":
      return "Reopened as draft";
    case "brief_payload_updated":
      return "Payload updated";
    case "brief_decided":
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

/**
 * Timeline of `events` rows for a single brief. Renders the SSR-fetched
 * initial set immediately, then subscribes to the `briefs` table for
 * status/decision changes (the `events` table is intentionally NOT on the
 * Realtime publication — see db/SCHEMA.md). When the brief row changes, we
 * call `router.refresh()` so the server re-fetches both the brief and its
 * events list — that's the cheapest "live updates" path without a custom
 * channel.
 */
export function BriefTimeline({
  briefId,
  initialEvents,
}: {
  briefId: string;
  initialEvents: EventRow[];
}) {
  const router = useRouter();
  const [events, setEvents] = useState<EventRow[]>(initialEvents);

  useEffect(() => {
    setEvents(initialEvents);
  }, [initialEvents]);

  useRealtimeStream(
    useMemo(
      () => [
        {
          table: "briefs",
          event: "UPDATE" as const,
          filter: `id=eq.${briefId}`,
          callback: () => router.refresh(),
        },
      ],
      [briefId, router],
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
        return (
          <li key={event.id} className="rounded-md border bg-card px-3 py-2 text-sm shadow-sm">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="font-medium">{eventLabel(event.kind)}</span>
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
