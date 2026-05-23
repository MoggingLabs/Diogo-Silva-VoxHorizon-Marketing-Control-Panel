import { CheckCircle2, AlertTriangle, Clock } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * Compact progress chip summarising a gate's per-creative rollup for the
 * CreativeReviewGrid header (#357, P4.2).
 *
 * Reads "N of M cleared" where a creative is *cleared* when its gate unit is
 * `passed | overridden | skipped` (the same predicate the server-side
 * `pipeline_rollup_cleared` uses to open the gate). Colour encodes urgency:
 *   - any `blocked` (failed) creative → rose (the gate is hard-held)
 *   - none blocked but some `pending` → amber (work outstanding)
 *   - all cleared, none pending/blocked → emerald (gate clears)
 *
 * Pure presentational: the caller supplies the already-summed counts. Counts
 * are clamped to ≥ 0 so a malformed prop never renders a negative.
 */
export type RollupCounts = {
  /** Total picked, non-killed creatives in scope for this gate. */
  total: number;
  /** Creatives whose unit is passed | overridden | skipped. */
  cleared: number;
  /** Creatives whose unit is failed (holds the gate). */
  blocked: number;
  /** Creatives whose unit is pending | in_progress (work outstanding). */
  pending: number;
};

export type RollupChipProps = RollupCounts & {
  className?: string;
};

type Tone = "cleared" | "pending" | "blocked";

const TONE_CLASS: Record<Tone, string> = {
  cleared:
    "bg-emerald-100 text-emerald-900 ring-emerald-300 dark:bg-emerald-950/40 dark:text-emerald-200 dark:ring-emerald-800",
  pending:
    "bg-amber-100 text-amber-900 ring-amber-300 dark:bg-amber-950/40 dark:text-amber-200 dark:ring-amber-800",
  blocked:
    "bg-rose-100 text-rose-900 ring-rose-300 dark:bg-rose-950/40 dark:text-rose-200 dark:ring-rose-800",
};

const TONE_ICON: Record<Tone, typeof CheckCircle2> = {
  cleared: CheckCircle2,
  pending: Clock,
  blocked: AlertTriangle,
};

const clamp = (n: number): number => (n > 0 ? Math.floor(n) : 0);

export function RollupChip({ total, cleared, blocked, pending, className }: RollupChipProps) {
  const totalN = clamp(total);
  const clearedN = Math.min(clamp(cleared), totalN);
  const blockedN = clamp(blocked);
  const pendingN = clamp(pending);

  // Blocked dominates (hard hold); then any outstanding work; then fully clear.
  let tone: Tone = "cleared";
  if (blockedN > 0) {
    tone = "blocked";
  } else if (pendingN > 0 || clearedN < totalN) {
    tone = "pending";
  }

  const Icon = TONE_ICON[tone];
  const blockedSuffix = blockedN > 0 ? `, ${blockedN} blocked` : "";
  const label = `${clearedN} of ${totalN} cleared${blockedSuffix}`;

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset [&_svg]:size-3.5 [&_svg]:shrink-0",
        TONE_CLASS[tone],
        className,
      )}
      data-testid="rollup-chip"
      data-tone={tone}
      title={label}
    >
      <Icon aria-hidden="true" />
      <span>
        {clearedN} of {totalN} cleared
        {blockedN > 0 ? <span className="font-semibold"> · {blockedN} blocked</span> : null}
      </span>
    </span>
  );
}
