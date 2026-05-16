import Link from "next/link";
import type { Route } from "next";
import type { ReactNode } from "react";
import { Inbox } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type EmptyStateProps = {
  /** Optional icon rendered above the title. Defaults to a neutral inbox glyph. */
  icon?: ReactNode;
  /** Required heading describing what's missing. */
  title: string;
  /** Optional second line explaining the empty state and/or next step. */
  description?: ReactNode;
  /** Optional CTA. `href` renders a `<Link>`, `onClick` renders a `<button>`. */
  action?: {
    label: string;
    href?: string;
    onClick?: () => void;
  };
  /** Override the outer wrapper classes (e.g. compact variant inside a column). */
  className?: string;
  /** Compact variant — less vertical padding, smaller copy. */
  compact?: boolean;
};

/**
 * Shared empty-state primitive used across list/grid/board components.
 *
 * Centered card with a dashed border, optional icon, title, description,
 * and a single primary action. Light-mode only to match the rest of v1.
 */
export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
  compact = false,
}: EmptyStateProps) {
  const renderedIcon = icon ?? (
    <Inbox
      className={cn(compact ? "h-5 w-5" : "h-8 w-8", "text-muted-foreground")}
      aria-hidden="true"
    />
  );

  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center rounded-md border border-dashed bg-muted/30 text-center",
        compact ? "gap-2 px-4 py-6" : "gap-3 px-6 py-12",
        className,
      )}
    >
      <div className="flex items-center justify-center text-muted-foreground">{renderedIcon}</div>
      <div className="flex flex-col gap-1">
        <p className={cn("font-medium text-foreground", compact ? "text-xs" : "text-sm")}>
          {title}
        </p>
        {description ? (
          <p className={cn("text-muted-foreground", compact ? "text-[11px]" : "text-xs")}>
            {description}
          </p>
        ) : null}
      </div>
      {action ? (
        <div className="pt-1">
          {action.href ? (
            <Button asChild size={compact ? "sm" : "default"}>
              <Link href={action.href as Route}>{action.label}</Link>
            </Button>
          ) : (
            <Button onClick={action.onClick} size={compact ? "sm" : "default"}>
              {action.label}
            </Button>
          )}
        </div>
      ) : null}
    </div>
  );
}
