import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export type KanbanColumnProps = {
  title: string;
  /** Count rendered next to the title; usually equals children.length. */
  count: number;
  /** Tailwind class for the accent dot on the column header. */
  accentClass?: string;
  /** Card list. Empty arrays render the empty-state copy. */
  children?: ReactNode;
  /** Optional message rendered when there are no cards. */
  emptyMessage?: string;
};

/**
 * Single Kanban column: sticky header with title + count, scrollable card
 * area below. Width is fixed (260px) so multiple columns scroll horizontally
 * inside the parent track on narrow viewports.
 */
export function KanbanColumn({
  title,
  count,
  accentClass = "bg-zinc-400",
  children,
  emptyMessage = "No data yet.",
}: KanbanColumnProps) {
  const hasContent = Array.isArray(children)
    ? children.some((c) => c !== null && c !== undefined && c !== false)
    : Boolean(children);

  return (
    <div className="flex w-[240px] shrink-0 snap-start flex-col gap-2 rounded-lg border border-border bg-muted/30 p-3 sm:w-[260px]">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span aria-hidden="true" className={cn("h-2 w-2 shrink-0 rounded-full", accentClass)} />
          <h3 className="truncate text-sm font-semibold text-foreground">{title}</h3>
        </div>
        <span className="shrink-0 rounded-full bg-background px-2 py-0.5 text-[11px] font-medium tabular-nums text-muted-foreground">
          {count.toLocaleString()}
        </span>
      </div>
      <ul className="flex flex-col gap-2">
        {hasContent ? (
          children
        ) : (
          <li className="rounded-md border border-dashed border-border bg-background/50 px-3 py-6 text-center text-xs text-muted-foreground">
            {emptyMessage}
          </li>
        )}
      </ul>
    </div>
  );
}
