import {
  FUNNEL_STAGES,
  STAGE_BAR_COLORS,
  STAGE_DOT_COLORS,
  STAGE_LABELS,
  type DashboardFormat,
  type FunnelCounts,
  type FunnelStage,
} from "@/lib/dashboard-types";

import { MetricTile, type MetricTileBreakdown } from "./MetricTile";
import { StackedBar, type StackedBarSegment } from "./StackedBar";

export type FunnelHeaderProps = {
  format: DashboardFormat;
  counts: {
    image: FunnelCounts;
    video: FunnelCounts;
    combined: FunnelCounts;
  };
};

/**
 * Picks the right counts object based on the format toggle. For `both` we
 * show combined totals on the tiles + a breakdown so the operator can still
 * see image vs video subtotals at a glance.
 */
function activeCounts(counts: FunnelHeaderProps["counts"], format: DashboardFormat): FunnelCounts {
  if (format === "image") return counts.image;
  if (format === "video") return counts.video;
  return counts.combined;
}

/**
 * Top-of-dashboard funnel summary: 6 KPI tiles + a horizontal stacked bar
 * showing the lifecycle distribution. Pure presentational — input comes from
 * `getDashboardSnapshot()`.
 */
export function FunnelHeader({ format, counts }: FunnelHeaderProps) {
  const active = activeCounts(counts, format);

  const segments: StackedBarSegment[] = FUNNEL_STAGES.map((stage) => ({
    key: stage,
    label: STAGE_LABELS[stage],
    value: active[stage],
    className: STAGE_BAR_COLORS[stage],
  }));

  const buildBreakdown = (stage: FunnelStage): MetricTileBreakdown[] | undefined => {
    if (format !== "both") return undefined;
    return [
      { label: "Image", value: counts.image[stage] },
      { label: "Video", value: counts.video[stage] },
    ];
  };

  return (
    <section className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 sm:gap-3 md:grid-cols-3 lg:grid-cols-6">
        {FUNNEL_STAGES.map((stage) => (
          <MetricTile
            key={stage}
            label={STAGE_LABELS[stage]}
            value={active[stage]}
            accentClass={STAGE_DOT_COLORS[stage]}
            breakdown={buildBreakdown(stage)}
            delta={null}
          />
        ))}
      </div>
      <div className="rounded-lg border border-border bg-card p-3 shadow-sm sm:p-4">
        <StackedBar segments={segments} title="Lifecycle distribution" />
      </div>
    </section>
  );
}
