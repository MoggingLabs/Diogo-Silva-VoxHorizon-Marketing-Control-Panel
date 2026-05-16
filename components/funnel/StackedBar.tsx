import { cn } from "@/lib/utils";

export type StackedBarSegment = {
  /** Stable identifier — used as React key + tooltip target. */
  key: string;
  /** Human-readable stage name shown in the tooltip + legend. */
  label: string;
  /** Raw count for the stage. Width is computed as `value / total`. */
  value: number;
  /** Tailwind background class controlling the segment color. */
  className: string;
};

export type StackedBarProps = {
  segments: StackedBarSegment[];
  /** Optional title rendered above the bar. */
  title?: string;
  /**
   * Whether to render the inline legend below the bar. Defaults to true.
   * The legend pulls from `segments` so labels stay in lockstep.
   */
  showLegend?: boolean;
};

/**
 * Horizontal stacked bar built from pure flexbox + Tailwind. Recharts would
 * also do the job, but it's a heavy dep for one bar — we stay dependency-free
 * and let each segment width track its share of the total via `flexGrow`.
 *
 * Empty state: when every segment is 0 we still render the rail (zinc-100) so
 * the layout never collapses; we just skip the segment fills.
 */
export function StackedBar({ segments, title, showLegend = true }: StackedBarProps) {
  const total = segments.reduce((acc, s) => acc + s.value, 0);
  const hasData = total > 0;

  return (
    <div className="flex flex-col gap-3">
      {title ? (
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-foreground">{title}</h3>
          <span className="text-xs tabular-nums text-muted-foreground">
            {total.toLocaleString()} total
          </span>
        </div>
      ) : null}
      <div
        role="img"
        aria-label={
          hasData
            ? `Funnel breakdown: ${segments
                .filter((s) => s.value > 0)
                .map((s) => `${s.label} ${s.value}`)
                .join(", ")}`
            : "Funnel breakdown — no data yet"
        }
        className="flex h-3 w-full overflow-hidden rounded-full bg-zinc-100"
      >
        {hasData
          ? segments.map((segment) => {
              if (segment.value <= 0) return null;
              const widthPct = (segment.value / total) * 100;
              return (
                <div
                  key={segment.key}
                  className={cn("h-full transition-[flex-basis] duration-300", segment.className)}
                  style={{ flex: `${widthPct} 0 0%`, minWidth: "2px" }}
                  title={`${segment.label}: ${segment.value.toLocaleString()}`}
                />
              );
            })
          : null}
      </div>
      {showLegend ? (
        <ul className="flex flex-wrap items-center gap-x-4 gap-y-1">
          {segments.map((segment) => (
            <li
              key={segment.key}
              className="flex items-center gap-1.5 text-xs text-muted-foreground"
            >
              <span aria-hidden="true" className={cn("h-2 w-2 rounded-sm", segment.className)} />
              <span>{segment.label}</span>
              <span className="font-medium tabular-nums text-foreground">
                {segment.value.toLocaleString()}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
