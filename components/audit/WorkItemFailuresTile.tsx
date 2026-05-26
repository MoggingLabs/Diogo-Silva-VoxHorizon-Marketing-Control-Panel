import Link from "next/link";
import type { Route } from "next";

import { AlertTriangle } from "lucide-react";

import { StatusBadge } from "@/components/ui/StatusBadge";

/**
 * Silent-failure PR-2a: dead-letter view on the Audit page.
 *
 * Lists `work_item` rows in (`failed`, `timed_out`) grouped by `error_kind` so
 * the operator sees which classes of failure are recurring across pipelines.
 * Each grouping shows the latest few rows with a deep-link to the pipeline
 * detail page (where the WorkItemPanel surfaces the full retry chain).
 *
 * The tile is READ-ONLY — recovery actions live on the per-pipeline
 * WorkItemPanel (Redispatch ships in PR-2b). The tile renders nothing when
 * there are no failures; an empty board is a healthy board.
 */

export type WorkItemFailureRow = {
  id: string;
  kind: string;
  pipeline_id: string | null;
  status: "failed" | "timed_out";
  error_kind: string | null;
  error_detail: { msg?: string } | null;
  attempt: number;
  created_at: string;
};

export type WorkItemFailuresTileProps = {
  /** Failure rows, newest-first. Empty list -> the tile renders nothing. */
  rows: WorkItemFailureRow[];
};

export function WorkItemFailuresTile({ rows }: WorkItemFailuresTileProps) {
  if (rows.length === 0) return null;

  const grouped = new Map<string, WorkItemFailureRow[]>();
  for (const r of rows) {
    const key = r.error_kind ?? "(unclassified)";
    const list = grouped.get(key) ?? [];
    list.push(r);
    grouped.set(key, list);
  }

  // Sort groups by frequency (count desc), then by error_kind for stable
  // ordering when counts tie. Mostly the latest noisy class floats to the top.
  const groups = Array.from(grouped.entries()).sort((a, b) => {
    if (a[1].length !== b[1].length) return b[1].length - a[1].length;
    return a[0].localeCompare(b[0]);
  });

  return (
    <section
      aria-label="Work item failures"
      data-testid="work-item-failures-tile"
      className="flex flex-col gap-3 rounded-lg border border-destructive/30 bg-card p-4 shadow-sm"
    >
      <header className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-destructive" aria-hidden="true" />
          <h2 className="text-base font-semibold tracking-tight">Work item failures</h2>
        </div>
        <span className="text-xs text-muted-foreground">{rows.length} total</span>
      </header>
      <div className="flex flex-col gap-3">
        {groups.map(([errorKind, list]) => (
          <div
            key={errorKind}
            data-testid={`work-item-failure-group-${errorKind}`}
            className="flex flex-col gap-2 rounded-md border border-border bg-muted/30 p-3"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-medium">{errorKind}</span>
              <span className="text-xs text-muted-foreground">{list.length}</span>
            </div>
            <ul className="flex flex-col gap-1">
              {list.slice(0, 5).map((r) => {
                const msg =
                  r.error_detail && typeof r.error_detail.msg === "string"
                    ? r.error_detail.msg
                    : null;
                const truncated = msg && msg.length > 120 ? msg.slice(0, 120) + "…" : msg;
                const Wrapper = r.pipeline_id ? Link : "div";
                const href = r.pipeline_id ? (`/pipeline/${r.pipeline_id}` as Route) : undefined;
                return (
                  <li key={r.id}>
                    <Wrapper
                      // eslint-disable-next-line @typescript-eslint/no-explicit-any
                      href={href as any}
                      data-testid={`work-item-failure-row-${r.id}`}
                      className="flex flex-wrap items-center justify-between gap-2 rounded border border-transparent px-2 py-1 text-xs hover:border-border hover:bg-card"
                    >
                      <div className="flex min-w-0 flex-col">
                        <span className="truncate font-mono text-[11px] text-muted-foreground">
                          {r.kind} · attempt {r.attempt}
                        </span>
                        {truncated ? (
                          <span className="truncate text-muted-foreground">{truncated}</span>
                        ) : null}
                      </div>
                      <StatusBadge status={r.status} />
                    </Wrapper>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}
