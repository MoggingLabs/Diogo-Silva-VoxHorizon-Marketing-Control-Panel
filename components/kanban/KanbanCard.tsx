import Link from "next/link";

import type {
  DashboardClient,
  DashboardImageBrief,
  DashboardVideoBrief,
} from "@/lib/dashboard-types";
import { cn } from "@/lib/utils";

export type KanbanCardKind = "image" | "video";

type CommonBrief = {
  id: string;
  brief_id_human: string;
  status: string;
  created_at: string;
  client: DashboardClient | null;
};

export type KanbanCardProps =
  | { kind: "image"; brief: DashboardImageBrief }
  | { kind: "video"; brief: DashboardVideoBrief };

/**
 * Shared status-pill palette used across both verticals. Keeping the keys as
 * a `Record<string, string>` lets us survive an enum that grows later without
 * a TypeScript error — unknown statuses fall back to the neutral pill.
 */
const STATUS_PILL: Record<string, string> = {
  draft: "bg-zinc-100 text-zinc-700",
  posted: "bg-amber-100 text-amber-800",
  approved: "bg-emerald-100 text-emerald-800",
  approved_with_changes: "bg-sky-100 text-sky-800",
  rejected: "bg-rose-100 text-rose-800",
};

const STATUS_LABEL: Record<string, string> = {
  draft: "Draft",
  posted: "Posted",
  approved: "Approved",
  approved_with_changes: "Approved w/ changes",
  rejected: "Rejected",
};

const KIND_BADGE: Record<KanbanCardKind, { label: string; className: string }> = {
  image: { label: "IMG", className: "bg-violet-100 text-violet-700" },
  video: { label: "VID", className: "bg-cyan-100 text-cyan-700" },
};

/**
 * Returns a coarse "time since" label (e.g. "2h ago", "3d ago", "just now").
 * No moment.js — we keep it dependency-free and approximate.
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
 * Single Kanban card. Format-agnostic shell; only the link target differs
 * between image (`/briefs/[id]`) and video (`/briefs/video/[id]`). Click
 * surface is the full card via `<Link>`.
 */
export function KanbanCard(props: KanbanCardProps) {
  const { kind, brief }: { kind: KanbanCardKind; brief: CommonBrief } = props;
  const pillClass = STATUS_PILL[brief.status] ?? "bg-zinc-100 text-zinc-700";
  const pillLabel = STATUS_LABEL[brief.status] ?? brief.status;
  const kindBadge = KIND_BADGE[kind];

  return (
    <li className="list-none">
      <Link
        href={kind === "image" ? `/briefs/${brief.id}` : `/briefs/video/${brief.id}`}
        className={cn(
          "flex flex-col gap-2 rounded-md border border-border bg-card p-3 shadow-sm",
          "transition-colors transition-shadow hover:border-zinc-300 hover:shadow",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
        )}
      >
        <div className="flex items-center justify-between gap-2">
          <span className="font-mono text-xs text-foreground">{brief.brief_id_human}</span>
          <span
            className={cn(
              "rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
              kindBadge.className,
            )}
          >
            {kindBadge.label}
          </span>
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-xs text-muted-foreground">
            {brief.client?.slug ?? brief.client?.name ?? "no client"}
          </span>
          <span
            className={cn("shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium", pillClass)}
          >
            {pillLabel}
          </span>
        </div>
        <span className="text-[11px] text-muted-foreground">{timeSince(brief.created_at)}</span>
      </Link>
    </li>
  );
}
