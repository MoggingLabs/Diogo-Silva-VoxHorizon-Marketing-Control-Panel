"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { ClipboardList, Film } from "lucide-react";

import { EmptyState } from "@/components/EmptyState";
import {
  KANBAN_STAGES,
  STAGE_DOT_COLORS,
  STAGE_LABELS,
  type DashboardFormat,
  type DashboardImageBrief,
  type DashboardVideoBrief,
  type FunnelStage,
} from "@/lib/dashboard-types";
import { createClient } from "@/lib/supabase/browser";

import { KanbanCard } from "./KanbanCard";
import { KanbanColumn } from "./KanbanColumn";

export type KanbanBoardProps = {
  format: DashboardFormat;
  imageBriefs: DashboardImageBrief[];
  videoBriefs: DashboardVideoBrief[];
};

/**
 * The Brief column (first in the lifecycle) is the only one with real data in
 * Wave 1. The downstream stages all map to placeholder columns that render
 * their header + an empty-state message, so the UI shape stays stable as
 * M2/M3/V2/V3 wire data in.
 *
 * `briefStages` lists every brief status that lands in the Brief column.
 */
const BRIEF_COLUMN_STATUSES = new Set(["draft", "posted", "approved", "approved_with_changes"]);

/**
 * Two-track Kanban board (image + video) wired to Supabase Realtime. When any
 * row on `briefs` or `video_briefs` changes we call `router.refresh()`, which
 * re-runs the server component on `/` and rehydrates the snapshot props.
 */
export function KanbanBoard({ format, imageBriefs, videoBriefs }: KanbanBoardProps) {
  const router = useRouter();

  useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel("dashboard-kanban")
      .on("postgres_changes", { event: "*", schema: "public", table: "briefs" }, () =>
        router.refresh(),
      )
      .on("postgres_changes", { event: "*", schema: "public", table: "video_briefs" }, () =>
        router.refresh(),
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [router]);

  const renderImageTrack = format === "image" || format === "both";
  const renderVideoTrack = format === "video" || format === "both";

  return (
    <div className="flex flex-col gap-6">
      {renderImageTrack ? (
        <KanbanTrack
          title="Image briefs"
          accentClass="bg-violet-500"
          kind="image"
          briefs={imageBriefs}
        />
      ) : null}
      {renderVideoTrack ? (
        <KanbanTrack
          title="Video briefs"
          accentClass="bg-cyan-500"
          kind="video"
          briefs={videoBriefs}
        />
      ) : null}
    </div>
  );
}

type KanbanTrackProps =
  | { title: string; accentClass: string; kind: "image"; briefs: DashboardImageBrief[] }
  | { title: string; accentClass: string; kind: "video"; briefs: DashboardVideoBrief[] };

function KanbanTrack(props: KanbanTrackProps) {
  const { title, accentClass, kind, briefs } = props;
  const briefColumn = briefs.filter((b) => BRIEF_COLUMN_STATUSES.has(b.status));
  const trackIsEmpty = briefs.length === 0;

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <span aria-hidden="true" className={`h-2.5 w-2.5 rounded-full ${accentClass}`} />
        <h2 className="text-base font-semibold text-foreground">{title}</h2>
        <span className="text-xs text-muted-foreground">{briefs.length} active</span>
      </div>
      {trackIsEmpty ? (
        <EmptyState
          icon={
            kind === "image" ? (
              <ClipboardList className="h-8 w-8" aria-hidden="true" />
            ) : (
              <Film className="h-8 w-8" aria-hidden="true" />
            )
          }
          title={`No active ${kind} briefs`}
          description={
            kind === "image"
              ? "Create an image brief to populate the board."
              : "Create a video brief to populate the board."
          }
          action={{
            label: kind === "image" ? "New image brief" : "New video brief",
            href: kind === "image" ? "/briefs/new" : "/briefs/video/new",
          }}
        />
      ) : (
        <div className="flex gap-4 overflow-x-auto pb-2">
          {KANBAN_STAGES.map((stage: FunnelStage) => {
            const isBriefColumn = stage === "in_brief";
            const count = isBriefColumn ? briefColumn.length : 0;
            return (
              <KanbanColumn
                key={stage}
                title={STAGE_LABELS[stage]}
                count={count}
                accentClass={STAGE_DOT_COLORS[stage]}
                emptyMessage={
                  isBriefColumn ? "No briefs in this stage yet." : "Lands in a later milestone."
                }
              >
                {isBriefColumn
                  ? briefColumn.map((brief) =>
                      kind === "image" ? (
                        <KanbanCard
                          key={brief.id}
                          kind="image"
                          brief={brief as DashboardImageBrief}
                        />
                      ) : (
                        <KanbanCard
                          key={brief.id}
                          kind="video"
                          brief={brief as DashboardVideoBrief}
                        />
                      ),
                    )
                  : null}
              </KanbanColumn>
            );
          })}
        </div>
      )}
    </section>
  );
}
