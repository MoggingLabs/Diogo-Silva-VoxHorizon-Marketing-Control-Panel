import { Circle, Loader2, CheckCircle2, XCircle, ShieldAlert, MinusCircle } from "lucide-react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

/**
 * Per-creative sub-state for a single gate column (qa / compliance / copy /
 * spec) in the CreativeReviewGrid (#357, P4.2).
 *
 * Defined locally as a string-literal union so this presentational primitive
 * carries no dependency on the shared `lib/pipeline/types.ts` (owned by P1).
 * It mirrors the `stage_state_enum` in the architecture
 * (`pending → in_progress → {passed | failed | overridden | skipped}`) and
 * will be reconciled to the shared type when the grid is wired.
 */
export type SubState = "pending" | "in_progress" | "passed" | "failed" | "overridden" | "skipped";

/**
 * Colour + ring per state, traffic-light style to match the house `MetricBadge`
 * / `ApprovalAuditTrail` palette. `overridden` is amber (a human cleared a
 * `failed` unit — proceed, but it carries an audit note); `skipped` and
 * `pending` are neutral so they do not read as alarming.
 */
const pillVariants = cva(
  "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset [&_svg]:size-3 [&_svg]:shrink-0",
  {
    variants: {
      status: {
        pending: "bg-muted text-muted-foreground ring-border",
        in_progress:
          "bg-sky-100 text-sky-900 ring-sky-300 dark:bg-sky-950/40 dark:text-sky-200 dark:ring-sky-800",
        passed:
          "bg-emerald-100 text-emerald-900 ring-emerald-300 dark:bg-emerald-950/40 dark:text-emerald-200 dark:ring-emerald-800",
        failed:
          "bg-rose-100 text-rose-900 ring-rose-300 dark:bg-rose-950/40 dark:text-rose-200 dark:ring-rose-800",
        overridden:
          "bg-amber-100 text-amber-900 ring-amber-300 dark:bg-amber-950/40 dark:text-amber-200 dark:ring-amber-800",
        skipped: "bg-muted text-muted-foreground ring-border",
      },
    },
    defaultVariants: {
      status: "pending",
    },
  },
);

const STATE_ICON: Record<SubState, typeof Circle> = {
  pending: Circle,
  in_progress: Loader2,
  passed: CheckCircle2,
  failed: XCircle,
  overridden: ShieldAlert,
  skipped: MinusCircle,
};

const STATE_LABEL: Record<SubState, string> = {
  pending: "Pending",
  in_progress: "In progress",
  passed: "Passed",
  failed: "Failed",
  overridden: "Overridden",
  skipped: "Skipped",
};

export type SubStatePillProps = VariantProps<typeof pillVariants> & {
  /** The per-creative gate state to render. */
  status: SubState;
  /** Optional override for the visible label (defaults to a humanized name). */
  label?: string;
  /** Optional hover tooltip — e.g. an override note or failure reason. */
  title?: string;
  className?: string;
};

/**
 * A presentational pill summarising one creature's state in a gate column.
 * Pure: no data fetching, no realtime — the grid feeds it `status`. The
 * spinning icon for `in_progress` is decorative (`aria-hidden`); the text
 * label carries the meaning for screen readers.
 */
export function SubStatePill({ status, label, title, className }: SubStatePillProps) {
  const Icon = STATE_ICON[status];
  const text = label ?? STATE_LABEL[status];

  return (
    <span
      className={cn(pillVariants({ status }), className)}
      data-testid="sub-state-pill"
      data-status={status}
      title={title ?? text}
    >
      <Icon aria-hidden="true" className={cn(status === "in_progress" && "animate-spin")} />
      {text}
    </span>
  );
}
