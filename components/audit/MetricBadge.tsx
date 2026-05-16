import { cn } from "@/lib/utils";
import type { Verdict } from "@/lib/audit";

const VERDICT_LABEL: Record<Verdict, string> = {
  kill: "Kill",
  watch: "Watch",
  keep: "Keep",
};

/**
 * Tailwind classes per verdict. Red / amber / emerald maps directly to the
 * traffic-light metaphor in the Wave 4 spec.
 */
const VERDICT_CLASS: Record<Verdict, string> = {
  kill: "bg-rose-100 text-rose-900 ring-rose-300 dark:bg-rose-950/40 dark:text-rose-200 dark:ring-rose-800",
  watch:
    "bg-amber-100 text-amber-900 ring-amber-300 dark:bg-amber-950/40 dark:text-amber-200 dark:ring-amber-800",
  keep: "bg-emerald-100 text-emerald-900 ring-emerald-300 dark:bg-emerald-950/40 dark:text-emerald-200 dark:ring-emerald-800",
};

/** Class for the unverdicted (null) case — neutral, not alarming. */
const UNKNOWN_CLASS = "bg-muted text-muted-foreground ring-border";

export type MetricBadgeProps = {
  verdict: Verdict | null;
  /** Optional verdict reason — surfaced via `title` for hover tooltips. */
  reason?: string | null;
  className?: string;
};

/**
 * Pure presentational traffic-light pill. The `title` attribute provides a
 * native browser tooltip with the verdict reason — no portal / floating-ui
 * dependency needed for v1.
 */
export function MetricBadge({ verdict, reason, className }: MetricBadgeProps) {
  if (verdict === null) {
    return (
      <span
        className={cn(
          "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset",
          UNKNOWN_CLASS,
          className,
        )}
        title="No verdict computed yet"
      >
        —
      </span>
    );
  }

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset",
        VERDICT_CLASS[verdict],
        className,
      )}
      title={reason ?? VERDICT_LABEL[verdict]}
    >
      <span
        aria-hidden="true"
        className={cn(
          "h-1.5 w-1.5 rounded-full",
          verdict === "kill" && "bg-rose-500",
          verdict === "watch" && "bg-amber-500",
          verdict === "keep" && "bg-emerald-500",
        )}
      />
      {VERDICT_LABEL[verdict]}
    </span>
  );
}
