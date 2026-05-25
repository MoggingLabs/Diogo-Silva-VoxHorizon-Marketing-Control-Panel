import { Boxes } from "lucide-react";

import { StatusBadge } from "@/components/ui/StatusBadge";
import type { AdEntityRow } from "@/lib/ad-entity";

/**
 * Read-only view of the recorded Meta ad-entity graph for a launch package
 * (E5.1 / #595).
 *
 * `ad_entity` is worker/Meta-owned (recorder model): the operator creates the
 * PAUSED-first campaign -> adset -> ad -> creative graph via its MCP and the
 * worker records the ids. This panel just SHOWS what was recorded (kind, state,
 * Meta id, parent) so the operator can confirm the launch graph at a glance. It
 * never edits the rows — overlay corrections, where allowed, go through the
 * `overrides` overlay elsewhere.
 */
export type AdEntityGraphProps = {
  entities: AdEntityRow[];
};

const KIND_ORDER: Record<string, number> = {
  campaign: 0,
  adset: 1,
  ad: 2,
  creative: 3,
};

const KIND_INDENT: Record<string, string> = {
  campaign: "pl-0",
  adset: "pl-4",
  ad: "pl-8",
  creative: "pl-12",
};

export function AdEntityGraph({ entities }: AdEntityGraphProps) {
  if (entities.length === 0) {
    return (
      <section className="space-y-3" aria-label="Recorded ad entities">
        <div className="flex items-center gap-2">
          <Boxes aria-hidden="true" className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-lg font-semibold">Ad entities</h2>
        </div>
        <p
          data-testid="ad-entity-empty"
          className="rounded-md border border-dashed bg-muted/30 px-4 py-6 text-center text-sm text-muted-foreground"
        >
          No Meta entities recorded for this launch yet. The operator records the PAUSED-first
          campaign graph here once it is created.
        </p>
      </section>
    );
  }

  const sorted = [...entities].sort((a, b) => {
    const ka = KIND_ORDER[a.kind] ?? 99;
    const kb = KIND_ORDER[b.kind] ?? 99;
    if (ka !== kb) return ka - kb;
    return a.created_at.localeCompare(b.created_at);
  });

  return (
    <section className="space-y-3" aria-label="Recorded ad entities">
      <div className="flex items-center gap-2">
        <Boxes aria-hidden="true" className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-lg font-semibold">Ad entities</h2>
        <span className="text-xs text-muted-foreground">recorded · read-only</span>
      </div>
      <ul
        className="divide-y rounded-lg border border-border bg-card"
        data-testid="ad-entity-graph"
      >
        {sorted.map((e) => (
          <li
            key={e.id}
            data-testid={`ad-entity-${e.id}`}
            className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm"
          >
            <div className={`flex min-w-0 items-center gap-2 ${KIND_INDENT[e.kind] ?? ""}`}>
              <span className="rounded bg-muted px-1.5 py-0.5 text-xs font-medium capitalize text-muted-foreground">
                {e.kind}
              </span>
              <span className="truncate font-mono text-xs">{e.meta_id}</span>
            </div>
            <StatusBadge status={e.state} />
          </li>
        ))}
      </ul>
    </section>
  );
}
