"use client";

import { useEffect, useMemo, useState } from "react";
import { Edit3, MapPin, MessageSquare, RotateCw, Sparkles } from "lucide-react";

import { createRealtimeQueue } from "@/lib/realtime-queue";
import { createClient } from "@/lib/supabase/browser";
import type { CreativeIteration, IterationAuthorT, IterationKindT } from "@/lib/creatives";
import { cn } from "@/lib/utils";

type IterationKindIcon = typeof Sparkles;

const KIND_ICON: Record<IterationKindT, IterationKindIcon> = {
  generate: Sparkles,
  regenerate: RotateCw,
  annotate: MapPin,
  comment: MessageSquare,
  user_edit: Edit3,
};

const KIND_LABEL: Record<IterationKindT, string> = {
  generate: "Generated",
  regenerate: "Regenerated",
  annotate: "Annotated",
  comment: "Comment",
  user_edit: "Edit",
};

const AUTHOR_LABEL: Record<IterationAuthorT, string> = {
  user: "Operator",
  ekko: "Ekko",
};

const AUTHOR_BUBBLE: Record<IterationAuthorT, string> = {
  user: "bg-zinc-100 text-zinc-900",
  ekko: "bg-violet-100 text-violet-900",
};

function timeSince(iso: string): string {
  try {
    const then = new Date(iso).getTime();
    if (!Number.isFinite(then)) return "—";
    const diffMs = Date.now() - then;
    if (diffMs < 0) return "just now";
    const m = Math.floor(diffMs / 60_000);
    if (m < 1) return "just now";
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    const d = Math.floor(h / 24);
    if (d < 30) return `${d}d ago`;
    const mo = Math.floor(d / 30);
    return `${mo}mo ago`;
  } catch {
    return "—";
  }
}

/**
 * Best-effort one-line preview for an iteration's jsonb `content`. We don't
 * own the shape of the payload (the worker decides), so this is intentionally
 * defensive: pick a useful string if we recognize one, otherwise stringify.
 */
function contentPreview(content: CreativeIteration["content"]): string {
  if (content === null || content === undefined) return "";
  if (typeof content === "string") return content;
  if (typeof content === "object" && !Array.isArray(content)) {
    const record = content as Record<string, unknown>;
    for (const key of ["message", "text", "comment", "note", "prompt", "summary"]) {
      const v = record[key];
      if (typeof v === "string" && v.trim().length > 0) return v.trim();
    }
  }
  try {
    return JSON.stringify(content);
  } catch {
    return "";
  }
}

function authorInitials(author: IterationAuthorT): string {
  return author === "user" ? "OP" : "EK";
}

export type IterationThreadProps = {
  creativeId: string;
  initialIterations: CreativeIteration[];
};

/**
 * Chat-style thread of iterations for a single creative. Server hands us
 * the initial list (oldest-first); we then subscribe to Realtime for
 * `creative_iterations` rows filtered by `creative_id` and append new
 * entries as they land.
 *
 * The worker (Agent CB) writes the `generate` / `regenerate` rows; the
 * operator UI plus future Ekko chat writes `comment` / `annotate` /
 * `user_edit` rows. Either way, this component just renders what's in
 * the table — schema is the contract.
 */
export function IterationThread({ creativeId, initialIterations }: IterationThreadProps) {
  const [iterations, setIterations] = useState<CreativeIteration[]>(initialIterations);

  useEffect(() => {
    setIterations(initialIterations);
  }, [initialIterations]);

  useEffect(() => {
    // Iterations are chat-shaped — operators expect new lines to land
    // instantly. We still use `createRealtimeQueue` so the structure
    // matches sibling components, but every event goes through
    // `flushNow` (no debounce) per the forge "chat events bypass batch"
    // rule.
    const queue = createRealtimeQueue();
    const supabase = createClient();
    const channel = supabase
      .channel(`creative-iterations:${creativeId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "creative_iterations",
          filter: `creative_id=eq.${creativeId}`,
        },
        (payload) => {
          const next = payload.new as CreativeIteration;
          queue.flushNow(`insert:${next.id}`, () => {
            setIterations((prev) => {
              if (prev.some((it) => it.id === next.id)) return prev;
              return [...prev, next];
            });
          });
        },
      )
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "creative_iterations",
          filter: `creative_id=eq.${creativeId}`,
        },
        (payload) => {
          const next = payload.new as CreativeIteration;
          queue.flushNow(`update:${next.id}`, () => {
            setIterations((prev) => prev.map((it) => (it.id === next.id ? next : it)));
          });
        },
      )
      .subscribe();

    return () => {
      queue.dispose();
      void supabase.removeChannel(channel);
    };
  }, [creativeId]);

  const sorted = useMemo(
    () =>
      [...iterations].sort(
        (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
      ),
    [iterations],
  );

  if (sorted.length === 0) {
    return (
      <p className="rounded-md border border-dashed bg-muted/30 px-3 py-4 text-center text-xs text-muted-foreground">
        No iterations yet.
      </p>
    );
  }

  return (
    <ol className="space-y-3" data-thread-searchable>
      {sorted.map((iter) => {
        const kind = iter.kind as IterationKindT;
        const author = iter.author as IterationAuthorT;
        const Icon = KIND_ICON[kind] ?? MessageSquare;
        const kindLabel = KIND_LABEL[kind] ?? kind;
        const preview = contentPreview(iter.content);

        return (
          <li key={iter.id} className="flex gap-3" data-thread-searchable>
            <span
              className={cn(
                "flex h-7 w-7 shrink-0 select-none items-center justify-center rounded-full text-[10px] font-semibold uppercase",
                AUTHOR_BUBBLE[author] ?? "bg-zinc-100 text-zinc-700",
              )}
              aria-hidden="true"
            >
              {authorInitials(author)}
            </span>
            <div className="min-w-0 flex-1 rounded-md border bg-card px-3 py-2 text-sm shadow-sm">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="inline-flex items-center gap-1.5 text-xs font-medium text-foreground">
                  <Icon aria-hidden="true" className="h-3.5 w-3.5 text-muted-foreground" />
                  {kindLabel}
                  <span className="text-muted-foreground">· {AUTHOR_LABEL[author] ?? author}</span>
                </span>
                <span className="text-[11px] text-muted-foreground" title={iter.created_at}>
                  {timeSince(iter.created_at)}
                </span>
              </div>
              {preview ? (
                <p className="mt-1 whitespace-pre-wrap break-words text-sm text-muted-foreground">
                  {preview}
                </p>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
