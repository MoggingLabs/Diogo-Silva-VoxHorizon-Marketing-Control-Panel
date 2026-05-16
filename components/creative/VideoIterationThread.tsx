"use client";

import { useEffect, useMemo, useState } from "react";
import { Edit3, Film, FileText, MessageSquare, Mic, RotateCw, Search, Type } from "lucide-react";

import { createClient } from "@/lib/supabase/browser";
import { timeSince } from "@/lib/format-time";
import {
  ITERATION_AUTHOR_LABEL,
  ITERATION_KIND_LABEL,
  type VideoIteration,
  type VideoIterationAuthorT,
  type VideoIterationKindT,
} from "@/lib/video-creatives";
import { cn } from "@/lib/utils";

type IterationKindIcon = typeof FileText;

/**
 * Distinct icon per `video_iteration_kind`. Picked so the thread reads
 * at a glance — script vs voiceover vs b-roll vs render vs caption.
 */
const KIND_ICON: Record<VideoIterationKindT, IterationKindIcon> = {
  generate_script: FileText,
  regenerate_voiceover: Mic,
  search_broll: Search,
  swap_broll: Film,
  rerender: RotateCw,
  recaption: Type,
  comment: MessageSquare,
  user_edit: Edit3,
};

const AUTHOR_BUBBLE: Record<VideoIterationAuthorT, string> = {
  user: "bg-zinc-100 text-zinc-900",
  ekko: "bg-violet-100 text-violet-900",
};

/**
 * Best-effort one-line preview for an iteration's jsonb `content`.
 * The worker decides the shape; we look for common keys ("paths",
 * "message", "text", …) and fall back to JSON.
 */
function contentPreview(content: VideoIteration["content"]): string {
  if (content === null || content === undefined) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    try {
      return JSON.stringify(content);
    } catch {
      return "";
    }
  }
  if (typeof content === "object") {
    const record = content as Record<string, unknown>;
    for (const key of ["message", "text", "comment", "note", "prompt", "summary"]) {
      const v = record[key];
      if (typeof v === "string" && v.trim().length > 0) return v.trim();
    }
    // Pipeline-specific synthetic previews:
    if (record.paths && typeof record.paths === "object") {
      const paths = record.paths as Record<string, unknown>;
      const keys = Object.keys(paths).filter((k) => paths[k] !== null && paths[k] !== undefined);
      if (keys.length > 0) return `Updated: ${keys.join(", ")}`;
    }
    if (typeof record.voice_id === "string") return `Voice: ${record.voice_id}`;
    if (typeof record.theme === "string") return `Theme: ${record.theme}`;
  }
  try {
    return JSON.stringify(content);
  } catch {
    return "";
  }
}

function authorInitials(author: VideoIterationAuthorT): string {
  return author === "user" ? "OP" : "EK";
}

export type VideoIterationThreadProps = {
  creativeId: string;
  initialIterations: VideoIteration[];
};

/**
 * Chat-style thread of video iterations for one creative.
 *
 * Server hands us the initial list (oldest-first); we subscribe to
 * Realtime on `video_iterations` filtered by `creative_id` and append
 * new entries as they land. Each row gets a distinct icon and label
 * per `video_iteration_kind` — see `KIND_ICON` above.
 */
export function VideoIterationThread({ creativeId, initialIterations }: VideoIterationThreadProps) {
  const [iterations, setIterations] = useState<VideoIteration[]>(initialIterations);

  useEffect(() => {
    setIterations(initialIterations);
  }, [initialIterations]);

  useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel(`video-iterations:${creativeId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "video_iterations",
          filter: `creative_id=eq.${creativeId}`,
        },
        (payload) => {
          const next = payload.new as VideoIteration;
          setIterations((prev) => {
            if (prev.some((it) => it.id === next.id)) return prev;
            return [...prev, next];
          });
        },
      )
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "video_iterations",
          filter: `creative_id=eq.${creativeId}`,
        },
        (payload) => {
          const next = payload.new as VideoIteration;
          setIterations((prev) => prev.map((it) => (it.id === next.id ? next : it)));
        },
      )
      .subscribe();

    return () => {
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
    <ol className="space-y-3">
      {sorted.map((iter) => {
        const kind = iter.kind as VideoIterationKindT;
        const author = iter.author as VideoIterationAuthorT;
        const Icon = KIND_ICON[kind] ?? MessageSquare;
        const kindLabel = ITERATION_KIND_LABEL[kind] ?? kind;
        const preview = contentPreview(iter.content);

        return (
          <li key={iter.id} className="flex gap-3">
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
                  <span className="text-muted-foreground">
                    · {ITERATION_AUTHOR_LABEL[author] ?? author}
                  </span>
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
