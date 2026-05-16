import { cn } from "@/lib/utils";

export type MetricTileBreakdown = {
  /** Sub-label, e.g. "Image" or "Video". */
  label: string;
  value: number;
};

export type MetricTileProps = {
  /** Stage label, e.g. "In Brief". */
  label: string;
  /** Primary count rendered as the big number. */
  value: number;
  /** Tailwind background class for the accent dot. */
  accentClass?: string;
  /**
   * Optional sub-breakdown rendered below the primary count. Used in
   * `format=both` mode so the operator sees image + video subtotals.
   */
  breakdown?: MetricTileBreakdown[];
  /**
   * Optional delta line. We don't track historic data yet (M2+ wires events),
   * so callers pass `null` to render a placeholder dash; once we have a real
   * "last 24h" number this surface is already in place.
   */
  delta?: number | null;
};

/**
 * Single KPI tile inside the funnel header. Pure presentational — counts come
 * from `getDashboardSnapshot()`. Hover lift is the only motion; we keep the
 * tile read-only because clicking through to a filtered view isn't part of the
 * Wave 2 spec.
 */
export function MetricTile({
  label,
  value,
  accentClass = "bg-zinc-400",
  breakdown,
  delta,
}: MetricTileProps) {
  return (
    <div
      className={cn(
        "group flex flex-col gap-2 rounded-lg border border-border bg-card px-4 py-3 shadow-sm",
        "transition-shadow transition-transform hover:-translate-y-0.5 hover:shadow-md",
      )}
    >
      <div className="flex items-center gap-2">
        <span aria-hidden="true" className={cn("h-2.5 w-2.5 rounded-full", accentClass)} />
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {label}
        </span>
      </div>
      <div className="flex items-baseline gap-2">
        <span className="text-3xl font-semibold tabular-nums text-foreground">
          {value.toLocaleString()}
        </span>
        {breakdown && breakdown.length > 0 ? (
          <span className="text-xs text-muted-foreground">
            {breakdown.map((b) => `${b.label} ${b.value.toLocaleString()}`).join(" · ")}
          </span>
        ) : null}
      </div>
      <span className="text-xs text-muted-foreground">
        {typeof delta === "number"
          ? `${delta >= 0 ? "+" : ""}${delta.toLocaleString()} today`
          : "—"}
      </span>
    </div>
  );
}
