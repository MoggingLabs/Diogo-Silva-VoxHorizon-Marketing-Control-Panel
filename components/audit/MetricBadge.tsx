import { cn } from "@/lib/utils";
import type { Verdict } from "@/lib/audit";

const VERDICT_LABEL: Record<Verdict, string> = {
  kill: "Kill",
  watch: "Watch",
  keep: "Keep",
};

/**
 * Verdict -> design-system semantic class. The traffic-light metaphor from the
 * Wave 4 spec maps onto the shared status tokens (destructive / warning /
 * success) so the pill reads correctly in both light and dark themes without
 * per-mode overrides. Same soft-fill + inset-ring treatment as the canonical
 * status Badge.
 */
const VERDICT_CLASS: Record<Verdict, string> = {
  kill: "bg-destructive/15 text-destructive ring-destructive/30",
  watch: "bg-warning/15 text-warning ring-warning/30",
  keep: "bg-success/15 text-success ring-success/30",
};

/** Dot color per verdict, drawn from the same semantic tokens. */
const VERDICT_DOT: Record<Verdict, string> = {
  kill: "bg-destructive",
  watch: "bg-warning",
  keep: "bg-success",
};

/** Class for the unverdicted (null) case - neutral, not alarming. */
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
      <span aria-hidden="true" className={cn("h-1.5 w-1.5 rounded-full", VERDICT_DOT[verdict])} />
      {VERDICT_LABEL[verdict]}
    </span>
  );
}
