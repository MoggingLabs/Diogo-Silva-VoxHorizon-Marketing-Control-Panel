import { cn } from "@/lib/utils";
import {
  countWithStatus,
  type CopyField,
  type CopyPlatform,
  type CopyPlacement,
} from "@/lib/copy/platform-limits";

/**
 * Live character counter for a single copy field in the CopyComposer
 * (#359, P4.4). Pure presentational: the editor passes the current `value`
 * plus the destination `field` / `platform` / `placement`, and this renders the
 * count against the published limits from `lib/copy/platform-limits.ts`.
 *
 *   - at/under the recommended cap → muted (`ok`)
 *   - over recommended, at/under max → amber (`warn`, will truncate in preview)
 *   - over the hard cap → red (`error`) plus a "-N over" marker
 *
 * No state of its own; re-renders when the parent updates `value`.
 */
export type CharCounterProps = {
  /** Current field text. */
  value: string;
  /** Which copy field this counts (drives the limit lookup). */
  field: CopyField;
  /** Destination platform. */
  platform: CopyPlatform;
  /** Optional placement; falls back to the platform default (meta→feed). */
  placement?: CopyPlacement;
  className?: string;
};

const STATUS_CLASS = {
  ok: "text-muted-foreground",
  warn: "text-amber-600 dark:text-amber-400",
  error: "text-rose-600 dark:text-rose-400 font-medium",
} as const;

export function CharCounter({ value, field, platform, placement, className }: CharCounterProps) {
  const { len, recommended, max, status, over } = countWithStatus(
    value,
    field,
    platform,
    placement,
  );

  // The denominator we show: the recommended soft cap when published (that's
  // the number the author should aim for), otherwise the hard cap. Unlimited
  // (Infinity) surfaces have no published cap, so we show the bare count.
  const hasCap = Number.isFinite(max);
  const cap = recommended ?? max;

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 text-xs tabular-nums",
        STATUS_CLASS[status],
        className,
      )}
      data-testid="char-counter"
      data-status={status}
      aria-live="polite"
    >
      {hasCap ? (
        <>
          <span>
            {len}
            <span aria-hidden="true"> / </span>
            <span className="sr-only"> of </span>
            {cap}
          </span>
          {status === "error" ? <span data-testid="char-counter-over">-{over} over</span> : null}
        </>
      ) : (
        <span>{len}</span>
      )}
    </span>
  );
}
