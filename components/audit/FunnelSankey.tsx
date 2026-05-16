import {
  FUNNEL_STAGES,
  FUNNEL_STAGE_LABELS,
  type FunnelStageId,
  type FunnelTotals,
} from "@/lib/audit";

export type FunnelSankeyProps = {
  totals: FunnelTotals;
};

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

const WIDTH = 960;
const HEIGHT = 320;
const PADDING_X = 16;
const PADDING_Y = 24;
const NODE_WIDTH = 24;
const STAGE_GAP =
  (WIDTH - PADDING_X * 2 - NODE_WIDTH * FUNNEL_STAGES.length) / (FUNNEL_STAGES.length - 1);
const NODE_MIN_HEIGHT = 4;
const NODE_MAX_HEIGHT = HEIGHT - PADDING_Y * 2;

const STAGE_COLORS: Record<FunnelStageId, string> = {
  impressions: "#71717a", // zinc-500
  clicks: "#6366f1", // indigo-500
  leads: "#0ea5e9", // sky-500
  booked: "#f59e0b", // amber-500
  showed: "#10b981", // emerald-500
  sold: "#059669", // emerald-600
};

// Each flow's fill — slight transparency so overlaps read as layered ribbons.
const FLOW_COLOR = "rgba(99, 102, 241, 0.18)"; // indigo

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nodeX(i: number): number {
  return PADDING_X + i * (NODE_WIDTH + STAGE_GAP);
}

function valueScale(value: number, max: number): number {
  if (max <= 0) return NODE_MIN_HEIGHT;
  const range = NODE_MAX_HEIGHT - NODE_MIN_HEIGHT;
  return NODE_MIN_HEIGHT + (value / max) * range;
}

/** Returns the SVG path for a ribbon between two nodes (cubic-Bezier). */
function flowPath(
  x0: number,
  y0Top: number,
  y0Bottom: number,
  x1: number,
  y1Top: number,
  y1Bottom: number,
): string {
  const cx0 = x0 + (x1 - x0) * 0.5;
  const cx1 = x1 - (x1 - x0) * 0.5;
  // Top edge of the ribbon: (x0, y0Top) → (x1, y1Top)
  // Bottom edge: (x1, y1Bottom) → (x0, y0Bottom)
  return [
    `M ${x0} ${y0Top}`,
    `C ${cx0} ${y0Top}, ${cx1} ${y1Top}, ${x1} ${y1Top}`,
    `L ${x1} ${y1Bottom}`,
    `C ${cx1} ${y1Bottom}, ${cx0} ${y0Bottom}, ${x0} ${y0Bottom}`,
    "Z",
  ].join(" ");
}

function formatCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return value.toLocaleString();
}

function conversionRate(from: number, to: number): string {
  if (from <= 0) return "—";
  return `${((to / from) * 100).toFixed(1)}%`;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

type NodeGeom = {
  id: FunnelStageId;
  label: string;
  value: number;
  x: number;
  height: number;
  top: number;
  bottom: number;
};

/**
 * Pure-SVG Sankey rendering the audit funnel:
 *
 *   impressions → clicks → leads → booked → showed → sold
 *
 * Flow widths are proportional to the downstream count. Booked/showed/sold
 * are placeholders for the Wave 5 GHL booking integration; for now they
 * render as zero and the empty-state overlay surfaces the gap.
 *
 * Rendered as a server component so the SVG ships in the initial HTML — no
 * hydration cost.
 */
export function FunnelSankey({ totals }: FunnelSankeyProps) {
  const max = Math.max(...FUNNEL_STAGES.map((stage) => totals[stage]));

  // Center-align each node vertically.
  const centerY = HEIGHT / 2;
  const nodes: NodeGeom[] = FUNNEL_STAGES.map((stage, i) => {
    const value = totals[stage];
    const height = valueScale(value, max);
    const top = centerY - height / 2;
    return {
      id: stage,
      label: FUNNEL_STAGE_LABELS[stage],
      value,
      x: nodeX(i),
      height,
      top,
      bottom: top + height,
    };
  });

  const hasAnyData = max > 0;

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between">
        <h2 className="text-lg font-semibold">Funnel leak</h2>
        <span className="text-xs text-muted-foreground">
          Impressions → Clicks → Leads → Booked → Showed → Sold
        </span>
      </div>

      <div className="relative overflow-x-auto rounded-lg border border-border bg-card p-4 shadow-sm">
        <svg
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          role="img"
          aria-label="Audit funnel Sankey diagram"
          className="block h-auto w-full min-w-[640px]"
        >
          {/* Flows: one per adjacent pair. The ribbon thickness matches the
              downstream node's height, scaled within the upstream's height. */}
          {nodes.slice(0, -1).map((from, i) => {
            const to = nodes[i + 1];
            if (!to) return null;
            // Pinch the ribbon at both ends to the smaller of the two node
            // heights so it never extends outside either node.
            const ribbonHeight = Math.min(from.height, to.height);
            const fromMid = (from.top + from.bottom) / 2;
            const toMid = (to.top + to.bottom) / 2;
            return (
              <path
                key={`flow-${from.id}-${to.id}`}
                d={flowPath(
                  from.x + NODE_WIDTH,
                  fromMid - ribbonHeight / 2,
                  fromMid + ribbonHeight / 2,
                  to.x,
                  toMid - ribbonHeight / 2,
                  toMid + ribbonHeight / 2,
                )}
                fill={FLOW_COLOR}
              />
            );
          })}

          {/* Nodes */}
          {nodes.map((node) => (
            <g key={`node-${node.id}`}>
              <rect
                x={node.x}
                y={node.top}
                width={NODE_WIDTH}
                height={node.height}
                fill={STAGE_COLORS[node.id]}
                rx={3}
              />
              {/* Stage label above */}
              <text
                x={node.x + NODE_WIDTH / 2}
                y={PADDING_Y - 8}
                textAnchor="middle"
                className="fill-foreground text-[11px] font-medium"
              >
                {node.label}
              </text>
              {/* Count below */}
              <text
                x={node.x + NODE_WIDTH / 2}
                y={HEIGHT - PADDING_Y + 16}
                textAnchor="middle"
                className="fill-foreground text-[12px] font-semibold tabular-nums"
              >
                {formatCount(node.value)}
              </text>
            </g>
          ))}

          {/* Conversion rate labels between stages */}
          {nodes.slice(0, -1).map((from, i) => {
            const to = nodes[i + 1];
            if (!to) return null;
            const midX = (from.x + NODE_WIDTH + to.x) / 2;
            return (
              <text
                key={`rate-${from.id}-${to.id}`}
                x={midX}
                y={HEIGHT - PADDING_Y + 16}
                textAnchor="middle"
                className="fill-muted-foreground text-[10px] tabular-nums"
              >
                {conversionRate(from.value, to.value)}
              </text>
            );
          })}
        </svg>

        {!hasAnyData ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="rounded-md border border-border bg-card/95 px-4 py-2 text-sm text-muted-foreground shadow-sm">
              No funnel data yet — waiting for the worker pull.
            </div>
          </div>
        ) : null}
      </div>

      <p className="text-xs text-muted-foreground">
        Booked / Showed / Sold come from the GHL integration (Wave 5+). They render as zero until
        that data lands.
      </p>
    </section>
  );
}
