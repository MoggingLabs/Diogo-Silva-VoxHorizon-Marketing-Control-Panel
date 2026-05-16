"use client";

import { ImageOff } from "lucide-react";

import { STATUS_LABEL, STATUS_PILL, type Creative } from "@/lib/creatives";
import { cn } from "@/lib/utils";

export type CreativeCardProps = {
  creative: Creative;
  signedUrl: string | null;
  active?: boolean;
  onSelect: (id: string) => void;
};

/**
 * Coarse "time since" formatter, dependency-free. Matches the Kanban card
 * helper so the look stays consistent between dashboards.
 */
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
 * A single tile in the creative variants grid. Shows the rendered image
 * (or a placeholder when the worker hasn't produced one yet), a status
 * pill, and the concept/version/ratio metadata.
 *
 * Click opens the side panel via `?creative=<id>` — the parent grid owns
 * URL state via `router.replace` so the navigation is shareable but
 * doesn't push to history.
 */
export function CreativeCard({ creative, signedUrl, active, onSelect }: CreativeCardProps) {
  const status = creative.status;
  const pillClass = STATUS_PILL[status] ?? "bg-zinc-100 text-zinc-700";
  const pillLabel = STATUS_LABEL[status] ?? status;
  const concept = creative.concept?.trim() || "Untitled concept";

  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={() => onSelect(creative.id)}
      className={cn(
        "group flex flex-col gap-2 overflow-hidden rounded-md border bg-card text-left shadow-sm",
        "transition-all hover:border-zinc-300 hover:shadow-md",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
        active ? "border-zinc-400 ring-1 ring-zinc-300" : "border-border",
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
        <span
          className={cn(
            "absolute right-2 top-2 rounded-full px-2 py-0.5 text-[11px] font-medium shadow",
            pillClass,
          )}
        >
          {pillLabel}
        </span>
      </div>
      <div className="flex flex-col gap-1 px-3 pb-3 pt-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate text-sm font-medium text-foreground" title={concept}>
            {concept}
          </span>
          <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
            {creative.version}
          </span>
        </div>
        <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
          <span className="font-mono">{creative.ratio ?? "—"}</span>
          <span>{timeSince(creative.created_at)}</span>
        </div>
      </div>
    </button>
  );
}
