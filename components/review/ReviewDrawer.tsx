"use client";

import { useState } from "react";

import { SubStatePill } from "@/components/review/SubStatePill";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  CREATIVE_STAGE_ORDER,
  CREATIVE_STAGE_LABEL,
  buildGridRows,
  type CreativeStage,
  type GridCreative,
  type StageStateRow,
  type SubState,
} from "@/lib/review/grid";
import { cn } from "@/lib/utils";

/**
 * The promoted, tabbed ReviewDrawer (#358, P4.3). Promotes the orphaned
 * `components/creative/SidePanel` slide-over into a per-creative drill-in with
 * one tab per per-creative stage (QA / Compliance / Copy / Spec) plus a Preview
 * tab. Each stage tab shows that stage's verdict pill + a free-shape evidence
 * summary (the `creative_stage_state.summary` jsonb / the side-table evidence
 * the caller passes in).
 *
 * Kept presentational + self-contained so it is testable without a live
 * Supabase: the caller resolves the signed preview URL + the per-stage evidence
 * server-side and passes them down. Stage-specific authoring (copy editing,
 * override) is rendered into the tab via the optional `renderStageActions` slot
 * so the drawer doesn't grow a dependency on every gate component.
 */
export type StageEvidence = {
  /** Free-shape evidence summary for the stage (QA defects, findings, etc.). */
  summary?: unknown;
  /** A short human-readable note (override reason, fail reason). */
  note?: string | null;
};

export type ReviewDrawerProps = {
  creative: GridCreative | null;
  /** Flat creative_stage_state rows; the drawer filters to this creative. */
  states: StageStateRow[];
  /** Signed preview URL for the creative's render. */
  signedUrl?: string | null;
  /** Per-stage evidence summaries keyed by stage. */
  evidence?: Partial<Record<CreativeStage, StageEvidence>>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Stage to open on. Defaults to QA. */
  initialTab?: DrawerTab;
  /** Optional per-stage action slot (e.g. an override button, copy editor). */
  renderStageActions?: (stage: CreativeStage, creative: GridCreative) => React.ReactNode;
};

type DrawerTab = CreativeStage | "preview";

const TABS: { key: DrawerTab; label: string }[] = [
  { key: "preview", label: "Preview" },
  ...CREATIVE_STAGE_ORDER.map((s) => ({ key: s as DrawerTab, label: CREATIVE_STAGE_LABEL[s] })),
];

function formatSummary(summary: unknown): string | null {
  if (summary === null || summary === undefined) return null;
  if (typeof summary === "string") return summary.trim() || null;
  try {
    const s = JSON.stringify(summary, null, 2);
    return s === "{}" || s === "null" ? null : s;
  } catch {
    return String(summary);
  }
}

export function ReviewDrawer({
  creative,
  states,
  signedUrl,
  evidence,
  open,
  onOpenChange,
  initialTab = "creative_qa",
  renderStageActions,
}: ReviewDrawerProps) {
  const [tab, setTab] = useState<DrawerTab>(initialTab);

  if (!creative) {
    return (
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent>
          <SheetHeader>
            <SheetTitle>Creative not found</SheetTitle>
            <SheetDescription>
              The selected creative is no longer available. Close this drawer and pick another.
            </SheetDescription>
          </SheetHeader>
        </SheetContent>
      </Sheet>
    );
  }

  // Resolve this creative's row so each stage tab can read its verdict + lock.
  // buildGridRows always returns one row per input creative, so [0] is defined.
  const row = buildGridRows([creative], states)[0]!;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent data-testid="review-drawer">
        <SheetHeader className="pr-8">
          <SheetTitle className="truncate">{creative.concept ?? "Untitled concept"}</SheetTitle>
          <SheetDescription className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
            <span className="font-mono">{creative.id.slice(0, 8)}</span>
            <span aria-hidden="true">·</span>
            <span className="capitalize">{creative.status}</span>
          </SheetDescription>
        </SheetHeader>

        <div role="tablist" aria-label="Review sections" className="mt-4 flex flex-wrap gap-1">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              data-testid={`drawer-tab-${t.key}`}
              aria-selected={tab === t.key}
              onClick={() => setTab(t.key)}
              className={cn(
                "rounded-full px-3 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                tab === t.key
                  ? "bg-sky-100 text-sky-900 dark:bg-sky-950/40 dark:text-sky-200"
                  : "bg-muted text-muted-foreground hover:bg-muted/70",
              )}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="mt-4" data-testid={`drawer-panel-${tab}`} role="tabpanel">
          {tab === "preview" ? (
            <PreviewPanel concept={creative.concept} signedUrl={signedUrl ?? null} />
          ) : (
            <StagePanel
              stage={tab}
              status={row.cells[tab].status}
              locked={row.cells[tab].locked}
              note={evidence?.[tab]?.note ?? row.cells[tab].note}
              summary={evidence?.[tab]?.summary ?? row.cells[tab].status}
              actions={renderStageActions?.(tab, creative)}
            />
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function PreviewPanel({
  concept,
  signedUrl,
}: {
  concept: string | null;
  signedUrl: string | null;
}) {
  return (
    <section className="space-y-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Preview
      </h3>
      {signedUrl ? (
        <a
          href={signedUrl}
          target="_blank"
          rel="noreferrer noopener"
          className="block overflow-hidden rounded-md border bg-muted/40"
        >
          {/* eslint-disable-next-line @next/next/no-img-element -- signed URL needs a plain <img> */}
          <img
            src={signedUrl}
            alt={concept ?? "creative"}
            className="max-h-[420px] w-full object-contain"
          />
        </a>
      ) : (
        <div className="rounded-md border border-dashed bg-muted/30 px-3 py-8 text-center text-xs text-muted-foreground">
          No render yet.
        </div>
      )}
    </section>
  );
}

function StagePanel({
  stage,
  status,
  locked,
  note,
  summary,
  actions,
}: {
  stage: CreativeStage;
  status: SubState;
  locked: boolean;
  note: string | null;
  summary: unknown;
  actions?: React.ReactNode;
}) {
  const text = formatSummary(summary);
  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {CREATIVE_STAGE_LABEL[stage]}
        </h3>
        <SubStatePill status={status} title={note ?? undefined} />
      </div>

      {locked ? (
        <p
          data-testid={`drawer-locked-${stage}`}
          className="rounded-md border border-dashed bg-muted/30 px-3 py-2 text-xs text-muted-foreground"
        >
          This stage is locked until the previous stage clears for this creative.
        </p>
      ) : null}

      {note ? (
        <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
          {note}
        </p>
      ) : null}

      {text ? (
        <pre className="overflow-x-auto rounded-md border bg-muted/30 px-3 py-2 font-mono text-[11px] leading-relaxed text-foreground">
          {text}
        </pre>
      ) : (
        <p className="text-xs text-muted-foreground">No evidence recorded for this stage yet.</p>
      )}

      {actions ? <div data-testid={`drawer-actions-${stage}`}>{actions}</div> : null}
    </section>
  );
}
